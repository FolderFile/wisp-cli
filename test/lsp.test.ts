/**
 * Code diagnostics: the JSON-RPC framing and connection, the client and manager against a fake
 * language server (test/fixtures/lsp/fake-server.mjs), and a real server: the TypeScript 7 this
 * repository builds with.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { encodeMessage, ErrorCodes, JsonRpcConnection, type JsonRpcMessage, MessageReader, ResponseError } from "../src/lsp/jsonrpc.ts";
import { formatForModel, LspManager, MAX_ERRORS, MAX_MISSES } from "../src/lsp/manager.ts";
import { findRoot, isRustupStub, projectTypeScript, SERVERS, type ServerSpec, specFor, which } from "../src/lsp/servers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (check()) return;
		await sleep(25);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/** A fresh temp root with a project folder in it. */
function tempDirs(prefix = "wisp-test-"): { root: string; cwd: string } {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	return { root, cwd };
}
const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "fixtures", "lsp", "fake-server.mjs");
const REPO_TYPESCRIPT = resolve(here, "..", "node_modules", "typescript");

function fakeSpec(mode: string, log?: string, name = "fake-lsp", extra: string[] = []): ServerSpec {
	return {
		id: `fake-${mode}`,
		extensions: [".fk"],
		rootMarkers: ["fake.json"],
		languageId: () => "fake",
		commands: [],
		resolve: () => ({ command: process.execPath, args: [FAKE, `--mode=${mode}`, ...(log ? [`--log=${log}`] : []), ...extra], name }),
	};
}

const alive = (pid: number | undefined) => {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const logged = (file: string): JsonRpcMessage[] =>
	existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as JsonRpcMessage) : [];

// --- Framing ---------------------------------------------------------------------------------

test("framing: messages split anywhere, several per chunk, multi-byte text, odd headers", () => {
	const got: JsonRpcMessage[] = [];
	const errors: string[] = [];
	const reader = new MessageReader((m) => got.push(m), (e) => errors.push(e.message));
	const a: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "x", params: { text: "héllo 😀 ünïcode" } };
	const b: JsonRpcMessage = { jsonrpc: "2.0", method: "y", params: [1, 2] };
	const bytes = Buffer.concat([encodeMessage(a), encodeMessage(b)]);
	// One byte at a time: every split point, including inside the emoji and the header.
	for (const byte of bytes) reader.push(Buffer.from([byte]));
	assert.deepEqual(got, [a, b]);

	got.length = 0;
	reader.push(bytes);
	assert.deepEqual(got, [a, b], "two messages in one chunk");

	got.length = 0;
	const body = Buffer.from(JSON.stringify(b));
	reader.push(Buffer.from(`content-length: ${body.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n`));
	reader.push(body);
	assert.deepEqual(got, [b], "header names are case-insensitive, other headers ignored");

	got.length = 0;
	reader.push(Buffer.from("X-Nothing: 1\r\n\r\n"));
	reader.push(Buffer.concat([Buffer.from("Content-Length: 3\r\n\r\n{x}"), encodeMessage(b)]));
	assert.deepEqual(got, [b], "a bad header and a bad body are skipped");
	assert.equal(errors.length, 2);
});

test("connection: requests, errors, timeouts with $/cancelRequest, server requests, close", async () => {
	const toClient = new PassThrough();
	const toServer = new PassThrough();
	const client = new JsonRpcConnection(toClient, toServer);
	const sent: JsonRpcMessage[] = [];
	const serverReader = new MessageReader((m) => sent.push(m));
	toServer.on("data", (chunk: Buffer) => serverReader.push(chunk));
	const reply = (m: JsonRpcMessage) => toClient.write(encodeMessage(m));

	const ok = client.request("ping", { a: 1 });
	await waitFor(() => sent.length === 1);
	assert.equal(sent[0]!.method, "ping");
	reply({ jsonrpc: "2.0", id: sent[0]!.id!, result: { pong: true } });
	assert.deepEqual(await ok, { pong: true });

	const bad = client.request("boom", null);
	await waitFor(() => sent.length === 2);
	reply({ jsonrpc: "2.0", id: sent[1]!.id!, error: { code: -32000, message: "no" } });
	await assert.rejects(bad, (e: unknown) => e instanceof ResponseError && e.code === -32000 && e.message === "no");

	await assert.rejects(client.request("slow", null, { timeoutMs: 30 }), /timed out/);
	await waitFor(() => sent.some((m) => m.method === "$/cancelRequest"));
	const slowId = sent.find((m) => m.method === "slow")!.id;
	assert.deepEqual(sent.find((m) => m.method === "$/cancelRequest")!.params, { id: slowId });

	const abort = new AbortController();
	const aborted = client.request("long", null, { signal: abort.signal });
	abort.abort();
	await assert.rejects(aborted, /Aborted/);

	client.onRequest((method, params) => {
		if (method === "add") return (params as number[])[0]! + (params as number[])[1]!;
		throw new ResponseError(ErrorCodes.MethodNotFound, "unknown");
	});
	const notes: string[] = [];
	client.onNotification((method) => notes.push(method));
	const before = sent.length;
	reply({ jsonrpc: "2.0", id: 7, method: "add", params: [2, 3] });
	reply({ jsonrpc: "2.0", id: "s", method: "other", params: null });
	reply({ jsonrpc: "2.0", method: "note", params: {} });
	await waitFor(() => sent.length === before + 2);
	assert.deepEqual(sent.slice(before), [
		{ jsonrpc: "2.0", id: 7, result: 5 },
		{ jsonrpc: "2.0", id: "s", error: { code: ErrorCodes.MethodNotFound, message: "unknown" } },
	]);
	assert.deepEqual(notes, ["note"]);

	const pending = client.request("never", null);
	toClient.end();
	await assert.rejects(pending, /closed/);
	await assert.rejects(client.request("after", null), /closed/);
});

// --- Servers -----------------------------------------------------------------------------------

test("servers: which, file types, root folders, the project's TypeScript 7", () => {
	const { root, cwd } = tempDirs("wisp-lsp-");
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "my-server"), "#!/bin/sh\n", { mode: 0o755 });
	writeFileSync(join(bin, "not-exec"), "", { mode: 0o644 });
	assert.equal(which("my-server", `/nonexistent:${bin}`), join(bin, "my-server"));
	assert.equal(which("not-exec", bin), undefined);
	assert.equal(which("my-server", ""), undefined);

	// rustup's proxy for a component that is not installed fails; a real install would not.
	writeFileSync(join(bin, "rustup"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	symlinkSync(join(bin, "rustup"), join(bin, "rust-analyzer"));
	assert.equal(isRustupStub(join(bin, "rust-analyzer")), true);
	assert.equal(isRustupStub(join(bin, "my-server")), false);

	assert.equal(specFor("a/b.TSX")?.id, "typescript");
	assert.equal(specFor("x.py")?.id, "python");
	assert.equal(specFor("main.go")?.id, "go");
	assert.equal(specFor("lib.rs")?.id, "rust");
	assert.equal(specFor("a.hpp")?.id, "c");
	assert.equal(specFor("README.md"), undefined);
	assert.equal(specFor("a.tsx")!.languageId("a.tsx"), "typescriptreact");
	assert.equal(specFor("a.mjs")!.languageId("a.mjs"), "javascript");

	mkdirSync(join(cwd, "packages", "app", "src"), { recursive: true });
	writeFileSync(join(cwd, "package.json"), "{}");
	writeFileSync(join(cwd, "packages", "app", "tsconfig.json"), "{}");
	const file = join(cwd, "packages", "app", "src", "x.ts");
	assert.equal(findRoot(file, ["tsconfig.json", "package.json"], cwd), join(cwd, "packages", "app"));
	assert.equal(findRoot(join(cwd, "y.ts"), ["tsconfig.json", "package.json"], cwd), cwd);
	assert.equal(findRoot(join(cwd, "deep", "z.go"), ["no-such-marker-wisp"], cwd), cwd, "no marker: the session folder");
	assert.equal(findRoot("/elsewhere/z.go", ["no-such-marker-wisp"], cwd), "/elsewhere", "outside it: the file's folder");

	assert.equal(projectTypeScript(cwd), undefined);
	mkdirSync(join(cwd, "node_modules"));
	symlinkSync(REPO_TYPESCRIPT, join(cwd, "node_modules", "typescript"));
	const ts = projectTypeScript(join(cwd, "packages", "app"));
	assert.ok(ts, "found in a parent folder");
	assert.deepEqual(ts.args.slice(1), ["--lsp", "--stdio"]);
	assert.match(ts.name, /^TypeScript 7\./);
	mkdirSync(join(cwd, "old", "node_modules", "typescript"), { recursive: true });
	writeFileSync(join(cwd, "old", "node_modules", "typescript", "package.json"), JSON.stringify({ version: "5.9.3" }));
	assert.equal(projectTypeScript(join(cwd, "old")), undefined, "TypeScript 5 is served by typescript-language-server");
});

// --- Manager against the fake server -------------------------------------------------------------

test("manager: errors only, in order, at most 10 plus a count; a fixed file says so", async () => {
	const { cwd } = tempDirs("wisp-lsp-");
	const log = join(cwd, "..", "server.log");
	const lsp = new LspManager({ cwd, specs: [fakeSpec("push", log)] });
	const lines = Array.from({ length: 12 }, (_, i) => (i === 3 ? "WARN" : `x ERROR ${i}`)).reverse();
	writeFileSync(join(cwd, "a.fk"), lines.join("\n"));
	const report = await lsp.check("a.fk");
	assert.ok(report);
	assert.equal(report.total, 11, "the warning is not counted");
	assert.equal(report.errors.length, MAX_ERRORS);
	assert.equal(report.path, "a.fk");
	assert.equal(report.server, "fake-lsp");
	assert.deepEqual(
		report.errors.map((e) => e.range.start.line),
		[0, 1, 2, 3, 4, 5, 6, 7, 9, 10],
		"sorted by position",
	);
	const block = formatForModel(report)!;
	assert.equal(
		block,
		[
			'<diagnostics file="a.fk">',
			...[1, 2, 3, 4, 5, 6, 7, 8, 10, 11].map((n) => `${n}:3 error: bad thing on line ${n} (E1)`),
			"+1 more error",
			"</diagnostics>",
		].join("\n"),
	);

	writeFileSync(join(cwd, "a.fk"), "fine\nWARN\n");
	const fixed = await lsp.check("a.fk");
	assert.equal(fixed?.fixed, true);
	assert.equal(formatForModel(fixed!), '<diagnostics file="a.fk">\nNo errors.\n</diagnostics>');
	const clean = await lsp.check("a.fk");
	assert.equal(clean?.total, 0);
	assert.equal(formatForModel(clean!), undefined, "still clean: nothing to add");

	// One server for the folder, the file opened once and then changed with full text.
	assert.deepEqual(lsp.running(), ["fake-lsp"]);
	const clients = await lsp.clients();
	assert.equal(clients.length, 1);
	const pid = clients[0]!.pid;
	const received = logged(log);
	assert.equal(received.filter((m) => m.method === "initialize").length, 1);
	assert.equal(received.filter((m) => m.method === "textDocument/didOpen").length, 1);
	assert.equal(received.filter((m) => m.method === "textDocument/didChange").length, 2);
	assert.equal(received.filter((m) => m.method === "textDocument/didSave").length, 3);
	// The server's own requests were answered.
	const config = received.find((m) => m.id === 1000);
	assert.deepEqual(config?.result, [null, null]);
	assert.equal(received.find((m) => m.id === 1001)?.error?.code, ErrorCodes.MethodNotFound);

	await lsp.stopAll(true);
	assert.equal(alive(pid), false, "stopped");
	const end = logged(log).map((m) => m.method);
	assert.ok(end.includes("shutdown") && end.includes("exit"), "shut down politely");
	assert.equal(await lsp.check("a.fk"), undefined, "nothing starts after the final stop");
});

test("manager: open files changed or deleted outside edit and write are synced before a check", async () => {
	const { cwd } = tempDirs("wisp-lsp-");
	const log = join(cwd, "..", "server.log");
	for (const mode of ["push", "pull"]) {
		writeFileSync(join(cwd, "b.fk"), "DEFINES foo\n");
		writeFileSync(join(cwd, "a.fk"), "USES foo\n");
		const lsp = new LspManager({ cwd, specs: [fakeSpec(mode, log)] });
		assert.equal((await lsp.check("b.fk"))?.total, 0, `${mode}: b opened`);
		assert.equal((await lsp.check("a.fk"))?.total, 0, `${mode}: foo is defined in the open b`);

		// bash (or /undo, or an editor) rewrites b: the server must not keep its old copy.
		writeFileSync(join(cwd, "b.fk"), "DEFINES bar\n");
		const stale = await lsp.check("a.fk");
		assert.equal(stale?.total, 1, `${mode}: b was sent again`);
		assert.match(stale!.errors[0]!.message, /foo is not defined/);

		writeFileSync(join(cwd, "b.fk"), "DEFINES foo\n");
		assert.equal((await lsp.check("a.fk"))?.fixed, true, `${mode}: and again`);

		// b is deleted: it is closed, so its definitions are gone, and so are its diagnostics.
		const [client] = await lsp.clients();
		rmSync(join(cwd, "b.fk"));
		assert.equal((await lsp.check("a.fk"))?.total, 1, `${mode}: deleted b no longer counts`);
		assert.deepEqual(client!.openFiles(), [join(cwd, "a.fk")]);
		const closed = logged(log).filter((m) => m.method === "textDocument/didClose");
		assert.ok(closed.some((m) => (m.params as { textDocument: { uri: string } }).textDocument.uri.endsWith("/b.fk")));
		await lsp.stopAll(true);
		rmSync(log, { force: true });
	}
});

test("manager: a server gets its command's initialization options, settings and environment", async () => {
	const { cwd } = tempDirs("wisp-lsp-");
	const log = join(cwd, "..", "server.log");
	const base = fakeSpec("push", log);
	const spec: ServerSpec = {
		...base,
		resolve: (root) => ({
			...base.resolve(root)!,
			initializationOptions: { disableAutomaticTypingAcquisition: true },
			settings: { fake: { automaticTypeAcquisition: { enabled: false } } },
			env: { FAKE_ENV: "local" },
		}),
	};
	writeFileSync(join(cwd, "a.fk"), "ok\n");
	const lsp = new LspManager({ cwd, specs: [spec] });
	assert.ok(await lsp.check("a.fk"));
	await lsp.stopAll(true);
	const received = logged(log);
	assert.deepEqual((received.find((m) => m.method === "initialize")?.params as { initializationOptions: unknown }).initializationOptions, {
		disableAutomaticTypingAcquisition: true,
	});
	assert.deepEqual((received.find((m) => m.method === "workspace/didChangeConfiguration")?.params as { settings: unknown }).settings, {
		fake: { automaticTypeAcquisition: { enabled: false } },
	});
	// The server asks for the sections "fake" and "other".
	assert.deepEqual(received.find((m) => m.id === 1000)?.result, [{ automaticTypeAcquisition: { enabled: false } }, null]);
	assert.deepEqual(received.find((m) => m.method === "$env")?.params, { FAKE_ENV: "local" });
});

test("servers: no language server may download anything (type acquisition, modules, crates)", () => {
	const { cwd, root } = tempDirs("wisp-lsp-");
	mkdirSync(join(cwd, "node_modules"), { recursive: true });
	symlinkSync(REPO_TYPESCRIPT, join(cwd, "node_modules", "typescript"));
	const ts7 = projectTypeScript(cwd)!;
	assert.deepEqual(ts7.settings?.["js/ts"], { tsserver: { automaticTypeAcquisition: { enabled: false } } });
	assert.equal(ts7.env?.npm_config_offline, "true");

	// Stubs on PATH for the servers found there.
	const bin = join(root, "bin");
	mkdirSync(bin);
	for (const name of ["typescript-language-server", "gopls", "rust-analyzer"]) {
		writeFileSync(join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
	}
	const path = process.env.PATH;
	process.env.PATH = bin;
	try {
		const other = tempDirs("wisp-lsp-").cwd; // no TypeScript 7 here
		const find = (id: string) => SERVERS.find((spec) => spec.id === id)!.resolve(other)!;
		const tsls = find("typescript");
		assert.equal(tsls.name, "typescript-language-server");
		assert.deepEqual(tsls.initializationOptions, { disableAutomaticTypingAcquisition: true });
		assert.equal(tsls.env?.npm_config_offline, "true");
		assert.equal(find("go").env?.GOPROXY, "off");
		assert.equal(find("rust").env?.CARGO_NET_OFFLINE, "true");
	} finally {
		process.env.PATH = path;
	}
});

test("manager: push reports that come in two steps, pull with a retry", async () => {
	const { cwd } = tempDirs("wisp-lsp-");
	writeFileSync(join(cwd, "a.fk"), "ERROR\n");
	const twoPhase = new LspManager({ cwd, specs: [fakeSpec("two-phase")] });
	assert.equal((await twoPhase.check("a.fk"))?.total, 1, "the later, full report wins over the first empty one");
	await twoPhase.stopAll(true);

	const pull = new LspManager({ cwd, specs: [fakeSpec("pull")] });
	assert.equal((await pull.check("a.fk"))?.total, 1, "asked again after ServerCancelled");
	writeFileSync(join(cwd, "a.fk"), "ok\n");
	assert.equal((await pull.check("a.fk"))?.fixed, true);
	await pull.stopAll(true);
});

test("manager: a server that publishes only changes does not cost the timeout on a clean file", async () => {
	const { cwd } = tempDirs("wisp-lsp-");
	writeFileSync(join(cwd, "a.fk"), "fine\n");
	const lsp = new LspManager({ cwd, specs: [fakeSpec("dedup")], timeoutMs: 3000 });
	assert.equal((await lsp.check("a.fk"))?.total, 0);
	writeFileSync(join(cwd, "a.fk"), "still fine\n");
	let started = Date.now();
	assert.equal((await lsp.check("a.fk"))?.total, 0, "silence after a clean report: still clean");
	assert.ok(Date.now() - started < 1500, `quick (${Date.now() - started} ms)`);
	writeFileSync(join(cwd, "a.fk"), "ERROR\n");
	started = Date.now();
	assert.equal((await lsp.check("a.fk"))?.total, 1, "a new error is still reported");
	await lsp.stopAll(true);
});

test("manager: a slow first report (loading the project) does not make later clean edits wait", { timeout: 30_000 }, async () => {
	const { cwd } = tempDirs("wisp-lsp-");
	writeFileSync(join(cwd, "a.fk"), "fine\n");
	const lsp = new LspManager({ cwd, specs: [fakeSpec("dedup", undefined, "fake-lsp", ["--open-delay=2000"])], timeoutMs: 3000 });
	assert.equal((await lsp.check("a.fk"))?.total, 0, "the first report comes after the project loads");
	for (const text of ["a = 2\n", "a = 3\n", "ERROR\n", "a = 4\n", "a = 5\n", "a = 6\n"]) {
		writeFileSync(join(cwd, "a.fk"), text);
		const started = Date.now();
		const report = await lsp.check("a.fk");
		const took = Date.now() - started;
		assert.equal(report?.total, text.includes("ERROR") ? 1 : 0, text);
		assert.ok(took < 1500, `${JSON.stringify(text)} took ${took} ms`);
	}
	await lsp.stopAll(true);
});

test("manager: a silent server costs at most the timeout, and is given up on", async () => {
	const { cwd } = tempDirs("wisp-lsp-");
	writeFileSync(join(cwd, "a.fk"), "ERROR\n");
	const warnings: string[] = [];
	// Starting node can take a while on a busy machine; the start is given room, the edits are not.
	const lsp = new LspManager({ cwd, specs: [fakeSpec("silent")], timeoutMs: 300, startupTimeoutMs: 2000, warn: (m) => warnings.push(m) });
	for (let i = 0; i < MAX_MISSES; i++) {
		const started = Date.now();
		assert.equal(await lsp.check("a.fk"), undefined);
		assert.ok(Date.now() - started < (i === 0 ? 2500 : 1000), "bounded by the timeout");
	}
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, /fake-lsp sent no diagnostics for 3 edits in a row/);
	const started = Date.now();
	assert.equal(await lsp.check("a.fk"), undefined);
	assert.ok(Date.now() - started < 100, "skipped at once afterwards");
	assert.equal((await lsp.clients()).length, 0, "stopped");
	await lsp.stopAll(true);

	// Esc: the wait ends right away, and does not count as a miss.
	const quiet = new LspManager({ cwd, specs: [fakeSpec("silent")], timeoutMs: 5000 });
	const abort = new AbortController();
	setTimeout(() => abort.abort(), 100);
	const t = Date.now();
	assert.equal(await quiet.check("a.fk", abort.signal), undefined);
	assert.ok(Date.now() - t < 1000);
	await quiet.stopAll(true);
});

test("manager: the first edit gets its errors from a server that takes longer than the timeout to start", { timeout: 30_000 }, async () => {
	const { cwd } = tempDirs("wisp-lsp-");
	writeFileSync(join(cwd, "a.fk"), "ok\nERROR\n");
	// Default timeouts: a 3.5 s start is more than a check's 3 s, but within the start-up allowance.
	const lsp = new LspManager({ cwd, specs: [fakeSpec("slow-start", undefined, "fake-lsp", ["--delay=3500"])] });
	lsp.warm("a.fk");
	const report = await lsp.check("a.fk");
	assert.equal(report?.total, 1);
	// Once it has answered, checks are quick again.
	writeFileSync(join(cwd, "a.fk"), "ok\n");
	const started = Date.now();
	assert.equal((await lsp.check("a.fk"))?.fixed, true);
	assert.ok(Date.now() - started < 1000);
	await lsp.stopAll(true);
});

test("manager: a server that never finishes starting stalls one check at most, then is dropped", { timeout: 30_000 }, async () => {
	const { cwd } = tempDirs("wisp-lsp-");
	writeFileSync(join(cwd, "a.fk"), "ERROR\n");
	const warnings: string[] = [];
	const lsp = new LspManager({ cwd, specs: [fakeSpec("hang-start")], timeoutMs: 200, startupTimeoutMs: 400, warn: (m) => warnings.push(m) });
	let started = Date.now();
	assert.equal(await lsp.check("a.fk"), undefined);
	assert.ok(Date.now() - started < 1000, "bounded by the start-up allowance");
	for (let i = 1; i < MAX_MISSES; i++) {
		started = Date.now();
		assert.equal(await lsp.check("a.fk"), undefined);
		assert.ok(Date.now() - started < 100, "no more waiting for it");
	}
	assert.deepEqual(warnings, ["fake-lsp did not finish starting, so wisp stopped using it for this session."]);
	assert.equal(await lsp.check("a.fk"), undefined);
	assert.equal((await lsp.clients()).length, 0);
	await lsp.stopAll(true);
});

test("manager: a crash is reported once and the server is not used again; a stub is skipped quietly", async () => {
	const { cwd } = tempDirs("wisp-lsp-");
	writeFileSync(join(cwd, "a.fk"), "ERROR\n");
	const warnings: string[] = [];
	const crash = new LspManager({ cwd, specs: [fakeSpec("crash")], timeoutMs: 800, startupTimeoutMs: 800, warn: (m) => warnings.push(m) });
	assert.equal((await crash.check("a.fk"))?.total, undefined, "didOpen works, but the server publishes nothing in crash mode");
	const started = Date.now();
	assert.equal(await crash.check("a.fk"), undefined, "the change kills it");
	assert.ok(Date.now() - started < 700, "noticed without waiting for the full timeout");
	await waitFor(() => warnings.length === 1);
	assert.match(warnings[0]!, /fake-lsp exited with code 3: fatal: fake server crashed/);
	assert.equal(await crash.check("a.fk"), undefined);
	assert.equal((await crash.clients()).length, 0, "not restarted");
	assert.equal(warnings.length, 1);
	await crash.stopAll(true);

	const stubWarnings: string[] = [];
	const stub = new LspManager({ cwd, specs: [fakeSpec("no-start")], warn: (m) => stubWarnings.push(m) });
	assert.equal(await stub.check("a.fk"), undefined);
	assert.equal(await stub.check("a.fk"), undefined);
	assert.deepEqual(stubWarnings, [], "a server that never started is not worth a warning");

	const missing: ServerSpec = { ...fakeSpec("push"), resolve: () => undefined };
	const none = new LspManager({ cwd, specs: [missing] });
	assert.equal(await none.check("a.fk"), undefined);
	assert.equal(none.handles("a.fk"), true);
	assert.equal(none.handles("a.txt"), false);
});

/** A project using the TypeScript 7 this repository builds with (its tsc is a language server). */
function tsProject(cwd: string) {
	mkdirSync(join(cwd, "node_modules"), { recursive: true });
	symlinkSync(REPO_TYPESCRIPT, join(cwd, "node_modules", "typescript"));
	writeFileSync(join(cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "es2022", module: "nodenext" } }));
	writeFileSync(join(cwd, "util.ts"), "export function double(n: number): number {\n\treturn n * 2;\n}\n");
}

test("real server: TypeScript 7 finds a type error after an edit, and its fix", { timeout: 60_000 }, async () => {
	const { cwd } = tempDirs("wisp-lsp-");
	tsProject(cwd);
	writeFileSync(join(cwd, "main.ts"), 'import { double } from "./util.js";\nexport const four: number = double("2");\n');
	// The default server list: found through the project's node_modules.
	const lsp = new LspManager({ cwd });
	try {
		const broken = await lsp.check("main.ts");
		assert.ok(broken, "diagnostics arrived");
		assert.match(formatForModel(broken) ?? "", /<diagnostics file="main\.ts">\n2:36 error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'\.\n<\/diagnostics>/);
		assert.equal(broken.server.startsWith("TypeScript 7."), true);
		writeFileSync(join(cwd, "main.ts"), 'import { double } from "./util.js";\nexport const four: number = double(2);\n');
		const fixed = await lsp.check("main.ts");
		assert.ok(fixed);
		assert.match(formatForModel(fixed) ?? "", /No errors\./);
	} finally {
		await lsp.stopAll(true);
	}
});

test("real server: TypeScript 7 does not fetch types for a JavaScript file's packages", { timeout: 60_000 }, async () => {
	const { root, cwd } = tempDirs("wisp-lsp-");
	mkdirSync(join(cwd, "node_modules"), { recursive: true });
	symlinkSync(REPO_TYPESCRIPT, join(cwd, "node_modules", "typescript"));
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "p", dependencies: { lodash: "^4.17.21" } }));
	writeFileSync(join(cwd, "a.js"), 'const _ = require("lodash");\nconsole.log(_.chunk([1, 2], 1));\n');
	// Automatic type acquisition would set up its typings cache here and run npm install.
	const cache = join(root, "cache");
	const saved = process.env.XDG_CACHE_HOME;
	process.env.XDG_CACHE_HOME = cache;
	try {
		const lsp = new LspManager({ cwd });
		assert.ok(await lsp.check("a.js"), "diagnostics arrived");
		await sleep(2000);
		await lsp.stopAll(true);
	} finally {
		if (saved === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = saved;
	}
	assert.equal(existsSync(join(cache, "typescript")), false, "no typings cache, so no npm install");
});

const tsls = which("typescript-language-server");
test("real server: typescript-language-server (when installed)", { skip: tsls ? false : "typescript-language-server is not on PATH", timeout: 60_000 }, async () => {
	const { cwd } = tempDirs("wisp-lsp-");
	writeFileSync(join(cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }));
	writeFileSync(join(cwd, "a.ts"), "export const n: number = 'x';\n");
	const lsp = new LspManager({ cwd }); // default timeouts: the cold start fits the start-up allowance
	const report = await lsp.check("a.ts");
	await lsp.stopAll(true);
	assert.ok(report, "diagnostics arrived (a TypeScript with tsserver.js must be installed)");
	assert.equal(report.total, 1);
	assert.match(report.errors[0]!.message, /not assignable/);
});

// --- The feature, through wisp's Agent: diagnostics are appended to write results. ---

test("feature: a write_file result carries the file's errors; turned off, it does not", async () => {
	const { Agent } = await import("../src/core/agent.ts");
	const { modelInfo } = await import("../src/core/models.ts");
	const { SettingsStore } = await import("../src/core/settings.ts");
	const { installFeatures, shutdownFeatures } = await import("../src/features/index.ts");
	const { lspFeature } = await import("../src/features/lsp.ts");
	const { ALL_TOOLS } = await import("../src/tools/index.ts");
	const { cwd, root } = tempDirs("wisp-lsp-");
	writeFileSync(join(cwd, "fake.json"), "{}");
	const script = [
		[{ type: "tool_call" as const, id: "w1", name: "write_file", input: { path: "a.fk", content: "x ERROR one\n" } }],
		[{ type: "text" as const, text: "ok" }],
		[{ type: "tool_call" as const, id: "w2", name: "write_file", input: { path: "b.fk", content: "x ERROR two\n" } }],
		[{ type: "text" as const, text: "ok" }],
	];
	const provider = {
		name: "anthropic",
		model: "claude-haiku-5-5",
		async complete() {
			const content = script.shift()!;
			return { content, stopReason: content[0]!.type === "tool_call" ? "tool_use" : "end", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
		},
	} as never;
	const agent = new Agent({ cwd, provider, model: modelInfo("anthropic", "claude-haiku-5-5"), tools: ALL_TOOLS, system: "sys", thinking: "off" });
	const settings = new SettingsStore(cwd, { global: join(root, "g.json"), project: join(root, "p.json") });
	const ui = { interactive: false, notice: () => {}, flash: () => {}, render: () => {}, height: 24, select: async () => undefined, input: async () => undefined } as never;
	const feature = lspFeature({ specs: [fakeSpec("push")] });
	installFeatures({ cwd, agent, settings, ui, session: () => null as never, refreshTools: () => agent.refreshTools() }, [feature]);
	const results = () => agent.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result") as Array<{ content: string }>;
	await agent.run([{ type: "text", text: "go" }], new AbortController().signal);
	assert.match(results()[0]!.content, /<diagnostics file="a\.fk">\n1:3 error: bad thing on line 1/);
	settings.set("lsp", false);
	await agent.run([{ type: "text", text: "again" }], new AbortController().signal);
	assert.doesNotMatch(results()[1]!.content, /diagnostics/);
	await shutdownFeatures([feature]);
});
