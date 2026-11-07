/**
 * One running language server: start and initialize it, keep files in sync, and get the
 * diagnostics for a file after a change, by pull (textDocument/diagnostic) when the server offers
 * it and otherwise from the textDocument/publishDiagnostics notifications it sends.
 *
 * Files are opened as they are checked and stay open. Before each check, every open file is
 * compared with the disk (it may have changed through bash, /undo or an editor): a changed one is
 * sent again and a deleted one is closed, so the server never works from a stale copy.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ErrorCodes, JsonRpcConnection, ResponseError } from "./jsonrpc.js";
import type { ServerCommand } from "./servers.js";

export interface Position {
	line: number;
	character: number;
}
export interface Diagnostic {
	range: { start: Position; end: Position };
	/** 1 error, 2 warning, 3 information, 4 hint. */
	severity?: number;
	code?: string | number;
	source?: string;
	message: string;
}

export interface ExitInfo {
	code: number | null;
	signal: string | null;
	/** The end of what the server wrote to stderr. */
	stderr: string;
	/** True when it exited before answering initialize (not installed properly, wrong version...). */
	duringStart: boolean;
}

export interface ClientOptions {
	/** Called once when the server process ends without being stopped. */
	onExit?: (info: ExitInfo) => void;
	/** How long initialize may take. */
	startTimeoutMs?: number;
}

/** Open files larger than this are closed instead of sent again. */
export const MAX_SYNC_BYTES = 2 * 1024 * 1024;

/**
 * Push mode: after the first publish for the file, wait this long for more (servers often publish
 * syntax errors first and the type errors a moment later).
 */
export const PUSH_SETTLE_MS = 250;
/** Push mode, file that had no errors: shortest wait before taking silence for "still clean". */
export const PUSH_QUIET_MIN_MS = 600;
/** Push mode, file that had no errors, before any change was measured: wait this long instead. */
export const PUSH_QUIET_UNKNOWN_MS = 1000;
/**
 * Largest single latency sample. A server that is busy (indexing, loading a project) for one edit
 * must not make every later clean edit wait for the whole timeout.
 */
const LATENCY_SAMPLE_MAX_MS = 1000;
const STDERR_TAIL = 4096;

/** Server processes alive in this process, killed if wisp exits without stopping them. */
const live = new Set<ChildProcess>();
let exitHookInstalled = false;
function track(child: ChildProcess): void {
	live.add(child);
	child.once("exit", () => live.delete(child));
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => {
		for (const proc of live) proc.kill("SIGKILL");
	});
}

const keyOf = (uri: string): string => {
	try {
		return fileURLToPath(uri);
	} catch {
		return uri;
	}
};

interface Published {
	seq: number;
	version: number | undefined;
	diagnostics: Diagnostic[];
}

export class LspClient {
	readonly root: string;
	readonly server: ServerCommand;
	private readonly child: ChildProcess;
	private readonly connection: JsonRpcConnection;
	private capabilities: Record<string, any> = {};
	/** Open documents: path -> version. */
	private readonly versions = new Map<string, number>();
	/** Open documents: path -> the text the server has. */
	private readonly texts = new Map<string, string>();
	/** Latest pushed diagnostics: path -> report. */
	private readonly published = new Map<string, Published>();
	private seq = 0;
	/** Push mode: usual delay between a change and its first report, in milliseconds. */
	private latency: number | undefined;
	private readonly wake = new Set<() => void>();
	private stderr = "";
	private stopping = false;
	private started = false;
	private exitInfo: ExitInfo | undefined;
	private readonly exited: Promise<void>;

	private constructor(server: ServerCommand, root: string, options: ClientOptions) {
		this.server = server;
		this.root = root;
		this.child = spawn(server.command, server.args, {
			cwd: root,
			stdio: ["pipe", "pipe", "pipe"],
			env: server.env ? { ...process.env, ...server.env } : process.env,
			windowsHide: true,
			shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(server.command),
		});
		track(this.child);
		// Never keeps wisp running on its own; requests in flight hold their own timers.
		this.child.unref();
		for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) (stream as { unref?: () => void } | null)?.unref?.();
		this.child.stderr!.on("data", (chunk: Buffer) => {
			this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
		});
		this.connection = new JsonRpcConnection(this.child.stdout!, this.child.stdin!);
		this.connection.onNotification((method, params) => this.notification(method, params));
		this.connection.onRequest((method, params) => this.serverRequest(method, params));
		this.exited = new Promise((done) => {
			const finish = (code: number | null, signal: string | null) => {
				if (this.exitInfo) return;
				this.exitInfo = { code, signal, stderr: this.stderr.trim(), duringStart: !this.started };
				this.connection.close(new Error(`${server.name} exited`));
				for (const wake of [...this.wake]) wake();
				if (!this.stopping) options.onExit?.(this.exitInfo);
				done();
			};
			this.child.once("exit", finish);
			this.child.once("error", (error) => finish(null, (error as NodeJS.ErrnoException).code ?? "error"));
		});
	}

	/** Start `server` in `root` and initialize it. Rejects (with the process stopped) on failure. */
	static async start(server: ServerCommand, root: string, options: ClientOptions = {}): Promise<LspClient> {
		const client = new LspClient(server, root, options);
		try {
			await client.initialize(options.startTimeoutMs);
			client.started = true;
			return client;
		} catch (error) {
			await client.stop();
			const info = client.exitInfo;
			const detail = info?.stderr ? `: ${info.stderr.split("\n").at(-1)}` : "";
			throw new Error(`${server.name} did not start${detail || (error instanceof Error ? `: ${error.message}` : "")}`);
		}
	}

	get alive(): boolean {
		return !this.exitInfo && !this.stopping;
	}

	/** Process id (tests). */
	get pid(): number | undefined {
		return this.child.pid;
	}

	private async initialize(startTimeoutMs = 30_000): Promise<void> {
		const rootUri = pathToFileURL(this.root).href;
		const result = await this.connection.request<{ capabilities?: Record<string, any> }>(
			"initialize",
			{
				processId: process.pid,
				clientInfo: { name: "wisp" },
				rootUri,
				rootPath: this.root,
				workspaceFolders: [{ uri: rootUri, name: basename(this.root) }],
				initializationOptions: this.server.initializationOptions,
				capabilities: {
					general: { positionEncodings: ["utf-16"] },
					window: { workDoneProgress: false },
					workspace: { configuration: true, workspaceFolders: true },
					textDocument: {
						synchronization: { dynamicRegistration: false, didSave: true },
						publishDiagnostics: { versionSupport: true, relatedInformation: false },
						diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
					},
				},
			},
			{ timeoutMs: startTimeoutMs },
		);
		this.capabilities = result?.capabilities ?? {};
		this.connection.notify("initialized", {});
		this.connection.notify("workspace/didChangeConfiguration", { settings: this.server.settings ?? {} });
	}

	/**
	 * Tell the server `file` now contains `text`, and return its diagnostics, or undefined when
	 * they did not come by `deadline` (a Date.now() value) or the server is gone.
	 */
	async diagnostics(file: string, text: string, languageId: string, deadline: number, signal?: AbortSignal): Promise<Diagnostic[] | undefined> {
		if (!this.alive) return undefined;
		const uri = pathToFileURL(file).href;
		const key = keyOf(uri);
		const seen = this.seq;
		const previous = this.versions.get(key);
		const version = this.send(uri, key, text, languageId);
		return this.capabilities.diagnosticProvider
			? this.pull(uri, deadline, signal)
			: this.pushedAfter(key, seen, version, previous !== undefined, deadline, signal);
	}

	/** Open `uri` with `text`, or send its new text; returns the new version. */
	private send(uri: string, key: string, text: string, languageId?: string): number {
		const previous = this.versions.get(key);
		const version = (previous ?? 0) + 1;
		this.versions.set(key, version);
		this.texts.set(key, text);
		if (previous === undefined) {
			this.connection.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
		} else {
			this.connection.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
		}
		const save = this.capabilities.textDocumentSync?.save;
		if (save) {
			this.connection.notify("textDocument/didSave", { textDocument: { uri }, ...(save.includeText ? { text } : {}) });
		}
		return version;
	}

	/**
	 * Bring the open files other than `except` in line with the disk: send the ones that changed
	 * since the server got them, close the ones that are gone (their diagnostics are dropped).
	 * Returns the paths closed.
	 */
	async resync(except?: string): Promise<string[]> {
		const closed: string[] = [];
		for (const [key, sent] of [...this.texts]) {
			if (key === except || !this.alive) continue;
			const info = await stat(key).catch(() => undefined);
			const text = info?.isFile() && info.size <= MAX_SYNC_BYTES ? await readFile(key, "utf8").catch(() => undefined) : undefined;
			// The file may have been checked again meanwhile.
			if (this.texts.get(key) !== sent) continue;
			const uri = pathToFileURL(key).href;
			if (text === undefined) {
				this.versions.delete(key);
				this.texts.delete(key);
				this.published.delete(key);
				this.connection.notify("textDocument/didClose", { textDocument: { uri } });
				closed.push(key);
			} else if (text !== sent) {
				this.send(uri, key, text);
			}
		}
		return closed;
	}

	/** Paths of the open files (tests). */
	openFiles(): string[] {
		return [...this.texts.keys()];
	}

	private async pull(uri: string, deadline: number, signal?: AbortSignal): Promise<Diagnostic[] | undefined> {
		for (;;) {
			const timeoutMs = deadline - Date.now();
			if (timeoutMs <= 0 || signal?.aborted || !this.alive) return undefined;
			try {
				const report = await this.connection.request<{ kind?: string; items?: Diagnostic[] }>(
					"textDocument/diagnostic",
					{ textDocument: { uri } },
					{ timeoutMs, signal },
				);
				return Array.isArray(report?.items) ? report.items : [];
			} catch (error) {
				// The server dropped the request because the file changed meanwhile: ask again.
				if (error instanceof ResponseError && (error.code === ErrorCodes.ServerCancelled || error.code === ErrorCodes.RequestCancelled)) {
					await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
					continue;
				}
				return undefined;
			}
		}
	}

	private async pushedAfter(key: string, seen: number, version: number, changed: boolean, deadline: number, signal?: AbortSignal): Promise<Diagnostic[] | undefined> {
		const sent = Date.now();
		const before = this.published.get(key);
		const fresh = () => {
			const report = this.published.get(key);
			return report && report.seq > seen && (report.version === undefined || report.version >= version) ? report : undefined;
		};
		// Some servers (gopls, typescript-language-server) publish only when a file's diagnostics
		// change. When the file had none and nothing comes well past the server's usual delay after
		// a change, it is still clean.
		const quiet =
			before && before.diagnostics.length === 0
				? this.latency === undefined
					? PUSH_QUIET_UNKNOWN_MS
					: Math.max(PUSH_QUIET_MIN_MS, 3 * this.latency)
				: undefined;
		const first = Math.min(deadline, quiet === undefined ? deadline : sent + quiet);
		await this.until(() => fresh() !== undefined || !this.alive, first, signal);
		if (!fresh() && first < deadline && this.alive && !signal?.aborted) return [];
		if (!fresh()) return undefined;
		// Only changes are measured: the first report after didOpen includes loading the project.
		if (changed) {
			const delay = Math.min(LATENCY_SAMPLE_MAX_MS, Date.now() - sent);
			this.latency = this.latency === undefined ? delay : Math.round((this.latency + delay) / 2);
		}
		// Settle: take later reports for the same file until it stays quiet.
		for (;;) {
			const last = fresh()!.seq;
			const quietUntil = Math.min(deadline, Date.now() + PUSH_SETTLE_MS);
			const more = await this.until(() => (this.published.get(key)?.seq ?? 0) > last || !this.alive, quietUntil, signal);
			if (!more || !this.alive || Date.now() >= deadline) return fresh()?.diagnostics;
		}
	}

	/** Resolves true once `ready()` holds, false at `deadline` or on abort. */
	private until(ready: () => boolean, deadline: number, signal?: AbortSignal): Promise<boolean> {
		if (ready()) return Promise.resolve(true);
		return new Promise((resolve) => {
			const finish = (value: boolean) => {
				clearTimeout(timer);
				this.wake.delete(check);
				signal?.removeEventListener("abort", abort);
				resolve(value);
			};
			const check = () => {
				if (ready()) finish(true);
			};
			const abort = () => finish(false);
			const timer = setTimeout(() => finish(ready()), Math.max(0, deadline - Date.now()));
			this.wake.add(check);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}

	private notification(method: string, params: unknown): void {
		if (method !== "textDocument/publishDiagnostics") return;
		const { uri, version, diagnostics } = (params ?? {}) as { uri?: string; version?: number; diagnostics?: Diagnostic[] };
		if (typeof uri !== "string") return;
		this.published.set(keyOf(uri), {
			seq: ++this.seq,
			version: typeof version === "number" ? version : undefined,
			diagnostics: Array.isArray(diagnostics) ? diagnostics : [],
		});
		for (const wake of [...this.wake]) wake();
	}

	private serverRequest(method: string, params: unknown): unknown {
		switch (method) {
			case "workspace/configuration": {
				const items = (params as { items?: Array<{ section?: unknown }> } | undefined)?.items;
				return Array.isArray(items) ? items.map((item) => this.setting(item?.section)) : [];
			}
			case "workspace/workspaceFolders":
				return [{ uri: pathToFileURL(this.root).href, name: basename(this.root) }];
			case "workspace/applyEdit":
				return { applied: false };
			case "client/registerCapability":
			case "client/unregisterCapability":
			case "window/workDoneProgress/create":
			case "window/showMessageRequest":
			case "window/showDocument":
				return null;
			default:
				if (method.startsWith("workspace/") && method.endsWith("/refresh")) return null;
				throw new ResponseError(ErrorCodes.MethodNotFound, `Unhandled method ${method}`);
		}
	}

	/** The workspace setting for `section` ("js/ts", "a.b"), or null. */
	private setting(section: unknown): unknown {
		if (typeof section !== "string" || !this.server.settings) return null;
		let value: unknown = this.server.settings;
		for (const part of section.split(".")) {
			if (!value || typeof value !== "object") return null;
			value = (value as Record<string, unknown>)[part];
		}
		return value ?? null;
	}

	/** Ask the server to shut down; kill it if it has not exited after `graceMs`. */
	async stop(graceMs = 1000): Promise<void> {
		if (this.exitInfo) return;
		this.stopping = true;
		if (this.started && !this.connection.isClosed) {
			await this.connection.request("shutdown", null, { timeoutMs: graceMs }).catch(() => undefined);
			this.connection.notify("exit", null);
		}
		this.child.stdin?.end();
		const timer = setTimeout(() => this.child.kill("SIGKILL"), graceMs);
		if (!this.started) this.child.kill();
		await this.exited;
		clearTimeout(timer);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}
