#!/usr/bin/env node
/**
 * A tiny language server for tests. Every line containing ERROR is an error, WARN a warning, and
 * "USES <name>" an error unless an open file (as last sent) or, for files not open, the disk copy of
 * a file in the same folder has the line "DEFINES <name>" (a project-wide check, like a type error).
 *
 *   --mode=push       publish diagnostics after didOpen/didChange (default)
 *   --mode=two-phase  publish an empty list first, the real one 80 ms later
 *   --mode=dedup      publish only when a file's diagnostics changed (like gopls)
 *   --mode=pull       offer textDocument/diagnostic (answers ServerCancelled once first)
 *   --mode=silent     never report anything
 *   --mode=crash      exit with code 3 on the first didChange
 *   --mode=no-start   exit at once, like a stub that is not really installed
 *   --mode=slow-start push, but answer initialize only after --delay=<ms> (a cold start)
 *   --mode=hang-start never answer initialize
 *   --open-delay=<ms> publish after didOpen only after this long (loading the project)
 *   --log=<file>      append every message received, one JSON per line
 */

import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const mode = arg("mode", "push");
const log = arg("log", undefined);
const delay = Number(arg("delay", "0"));
const openDelay = Number(arg("open-delay", "0"));
const pushes = ["push", "two-phase", "dedup", "slow-start"].includes(mode);

if (mode === "no-start") {
	process.stderr.write("error: this is only a stub\n");
	process.exit(1);
}

const send = (message) => {
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
	process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
	process.stdout.write(body);
};

/** Whether `name` is defined anywhere the server can see: open files first, then the disk. */
const defined = (uri, name) => {
	const line = `DEFINES ${name}`;
	const has = (text) => text.split("\n").some((l) => l.trim() === line);
	if ([...docs.values()].some(has)) return true;
	const dir = dirname(fileURLToPath(uri));
	return readdirSync(dir).some((file) => !docs.has(pathToFileURL(join(dir, file)).href) && file.endsWith(".fk") && has(readFileSync(join(dir, file), "utf8")));
};

const diagnose = (text, uri) =>
	text.split("\n").flatMap((line, i) => {
		const out = [];
		const uses = /^USES (\w+)$/.exec(line.trim());
		if (uses && !defined(uri, uses[1])) out.push({ range: { start: { line: i, character: 0 }, end: { line: i, character: line.length } }, severity: 1, source: "fake", message: `${uses[1]} is not defined` });
		const error = line.indexOf("ERROR");
		if (error >= 0) out.push({ range: { start: { line: i, character: error }, end: { line: i, character: error + 5 } }, severity: 1, source: "fake", code: "E1", message: `bad thing on line ${i + 1}` });
		const warn = line.indexOf("WARN");
		if (warn >= 0) out.push({ range: { start: { line: i, character: warn }, end: { line: i, character: warn + 4 } }, severity: 2, source: "fake", message: "just a warning" });
		return out;
	});

const docs = new Map();
let cancelledOnce = false;
let nextId = 1000;

const lastSent = new Map();
const publish = (uri, version) => {
	const diagnostics = diagnose(docs.get(uri) ?? "", uri);
	if (mode === "dedup") {
		const hash = JSON.stringify(diagnostics);
		if (lastSent.get(uri) === hash) return;
		lastSent.set(uri, hash);
	}
	if (mode === "two-phase") {
		send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
		setTimeout(() => send({ method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics } }), 80);
	} else {
		send({ method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics } });
	}
};

const handle = (message) => {
	if (log) appendFileSync(log, `${JSON.stringify(message)}\n`);
	const { id, method, params } = message;
	switch (method) {
		case "initialize": {
			if (log) appendFileSync(log, `${JSON.stringify({ method: "$env", params: { FAKE_ENV: process.env.FAKE_ENV ?? null } })}\n`);
			if (mode === "hang-start") return;
			const answer = () =>
				send({
					id,
					result: {
						capabilities: { textDocumentSync: { openClose: true, change: 1, save: true }, ...(mode === "pull" ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } : {}) },
						serverInfo: { name: "fake" },
					},
				});
			if (delay > 0) setTimeout(answer, delay);
			else answer();
			return;
		}
		case "initialized":
			// Servers ask the client things; the client must answer.
			send({ id: nextId++, method: "workspace/configuration", params: { items: [{ section: "fake" }, { section: "other" }] } });
			send({ id: nextId++, method: "fake/unknownRequest", params: {} });
			return;
		case "textDocument/didOpen":
			docs.set(params.textDocument.uri, params.textDocument.text);
			if (pushes && openDelay > 0) setTimeout(() => publish(params.textDocument.uri, params.textDocument.version), openDelay);
			else if (pushes) publish(params.textDocument.uri, params.textDocument.version);
			return;
		case "textDocument/didChange":
			if (mode === "crash") {
				process.stderr.write("fatal: fake server crashed\n");
				process.exit(3);
			}
			docs.set(params.textDocument.uri, params.contentChanges.at(-1).text);
			if (pushes) publish(params.textDocument.uri, params.textDocument.version);
			return;
		case "textDocument/didClose":
			docs.delete(params.textDocument.uri);
			return;
		case "textDocument/diagnostic":
			if (!cancelledOnce) {
				cancelledOnce = true;
				send({ id, error: { code: -32802, message: "cancelled", data: { retriggerRequest: true } } });
				return;
			}
			send({ id, result: { kind: "full", items: diagnose(docs.get(params.textDocument.uri) ?? "", params.textDocument.uri) } });
			return;
		case "shutdown":
			send({ id, result: null });
			return;
		case "exit":
			process.exit(0);
			return;
		default:
			if (id !== undefined && method !== undefined) send({ id, error: { code: -32601, message: "nope" } });
	}
};

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const end = buffer.indexOf("\r\n\r\n");
		if (end < 0) return;
		const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
		if (buffer.length < end + 4 + length) return;
		const body = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
		buffer = buffer.subarray(end + 4 + length);
		handle(JSON.parse(body));
	}
});
process.stdin.on("end", () => process.exit(0));
