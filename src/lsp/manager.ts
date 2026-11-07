/**
 * The language servers of one session: started on first use per (server, root folder), kept
 * running, and stopped when the session ends. check() never throws and never takes longer than
 * its timeout, except while a server is starting: until STARTUP_TIMEOUT_MS after it was started,
 * a check may wait that long for it (a cold start, with the project loaded for its first answer,
 * takes seconds). A server that is missing, fails to start, has not started by then or keeps not
 * answering is skipped for the rest of the session.
 */

import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { type Diagnostic, type ExitInfo, LspClient } from "./client.js";
import { findRoot, SERVERS, type ServerCommand, type ServerSpec, specFor } from "./servers.js";

/** Longest a check waits for diagnostics after an edit, once the server has answered before. */
export const DIAGNOSTICS_TIMEOUT_MS = 3000;
/** Until this long after a server was started, checks may wait for it to start and first answer. */
export const STARTUP_TIMEOUT_MS = 10_000;
/** Errors listed for the model; the rest are counted. */
export const MAX_ERRORS = 10;
/** Files larger than this are not checked. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** A server that has never answered in time is given up on after this many checks in a row. */
export const MAX_MISSES = 3;

export interface FileReport {
	/** Absolute path. */
	file: string;
	/** Path as shown (relative to the session's folder when inside it). */
	path: string;
	/** Server that checked it ("TypeScript 7.0.2"). */
	server: string;
	/** Errors, in file order, at most MAX_ERRORS. */
	errors: Diagnostic[];
	/** All errors, including the ones not listed. */
	total: number;
	/** The previous check of this file found errors and this one found none. */
	fixed?: boolean;
}

export interface ManagerOptions {
	cwd: string;
	specs?: readonly ServerSpec[];
	timeoutMs?: number;
	startupTimeoutMs?: number;
	/** One-time problems worth telling the user (a server that crashed). */
	warn?: (message: string) => void;
}

interface Workspace {
	key: string;
	/** The server's name ("TypeScript 7.0.2"). */
	name: string;
	client: Promise<LspClient | undefined>;
	/** The client once it has started. */
	started?: LspClient;
	/** Date.now() until which checks may wait for the server to start and first answer. */
	startupUntil: number;
	misses: number;
	answered: boolean;
}

export class LspManager {
	readonly cwd: string;
	private readonly specs: readonly ServerSpec[];
	private readonly timeoutMs: number;
	private readonly startupTimeoutMs: number;
	private readonly warn: (message: string) => void;
	private readonly workspaces = new Map<string, Workspace>();
	/** Workspaces given up on for this session. */
	private readonly disabled = new Set<string>();
	/** Error counts of the last check, by file. */
	private readonly lastErrors = new Map<string, number>();
	private closed = false;

	constructor(options: ManagerOptions) {
		this.cwd = options.cwd;
		this.specs = options.specs ?? SERVERS;
		this.timeoutMs = options.timeoutMs ?? DIAGNOSTICS_TIMEOUT_MS;
		this.startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
		this.warn = options.warn ?? (() => {});
	}

	/** Whether `file` is a language wisp has a server spec for. */
	handles(file: string): boolean {
		return specFor(file, this.specs) !== undefined;
	}

	/** Start the server for `file` in the background, so it is ready when the edit lands. */
	warm(file: string): void {
		void this.workspace(resolve(this.cwd, file));
	}

	/**
	 * Diagnostics for `file` as it is on disk now. Undefined when there is no server for it, the
	 * server did not answer in time, or the file cannot be read.
	 */
	async check(file: string, signal?: AbortSignal): Promise<FileReport | undefined> {
		const now = Date.now();
		const absolute = resolve(this.cwd, file);
		try {
			const ws = this.workspace(absolute);
			if (!ws) return undefined;
			if (!ws.started && now >= ws.startupUntil) {
				// Still not started after its whole start-up allowance: do not wait for it again.
				this.missed(ws);
				return undefined;
			}
			const deadline = ws.answered ? now + this.timeoutMs : Math.max(now + this.timeoutMs, ws.startupUntil);
			const info = await stat(absolute);
			if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
			const text = await readFile(absolute, "utf8");
			const client = await raceDeadline(ws.client, deadline, signal);
			if (!client?.alive) {
				if (!client && !signal?.aborted && this.workspaces.get(ws.key) === ws) this.missed(ws);
				return undefined;
			}
			const spec = specFor(absolute, this.specs)!;
			// Other open files may have changed on disk since (bash, /undo, an editor) or be gone.
			for (const gone of await client.resync(absolute)) this.lastErrors.delete(gone);
			const diagnostics = await client.diagnostics(absolute, text, spec.languageId(absolute), deadline, signal);
			if (diagnostics === undefined) {
				if (!signal?.aborted) this.missed(ws);
				return undefined;
			}
			ws.answered = true;
			ws.misses = 0;
			return this.report(absolute, client.server, diagnostics);
		} catch {
			return undefined;
		}
	}

	private report(file: string, server: ServerCommand, diagnostics: Diagnostic[]): FileReport {
		const errors = diagnostics
			.filter((d) => (d.severity ?? 1) === 1 && typeof d.message === "string")
			.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
		const before = this.lastErrors.get(file) ?? 0;
		this.lastErrors.set(file, errors.length);
		const inside = relative(this.cwd, file);
		return {
			file,
			path: inside && !inside.startsWith("..") ? inside : file,
			server: server.name,
			errors: errors.slice(0, MAX_ERRORS),
			total: errors.length,
			...(errors.length === 0 && before > 0 ? { fixed: true } : {}),
		};
	}

	private missed(ws: Workspace): void {
		if (ws.answered || ++ws.misses < MAX_MISSES) return;
		this.disable(ws.key);
		const started = ws.started !== undefined;
		void ws.client.then((client) => client?.stop());
		const what = started ? `sent no diagnostics for ${MAX_MISSES} edits in a row` : "did not finish starting";
		this.warn(`${ws.name} ${what}, so wisp stopped using it for this session.`);
	}

	private disable(key: string): void {
		this.disabled.add(key);
		this.workspaces.delete(key);
	}

	/** The workspace serving `file`, started if needed; undefined when there is no server for it. */
	private workspace(file: string): Workspace | undefined {
		if (this.closed) return undefined;
		const spec = specFor(file, this.specs);
		if (!spec) return undefined;
		const root = findRoot(file, spec.rootMarkers, this.cwd);
		const key = `${spec.id}\0${root}`;
		if (this.disabled.has(key)) return undefined;
		const existing = this.workspaces.get(key);
		if (existing) return existing;
		const command = spec.resolve(root);
		if (!command) {
			// Not installed: nothing to say, the feature simply does not apply.
			this.disabled.add(key);
			return undefined;
		}
		const ws: Workspace = {
			key,
			name: command.name,
			misses: 0,
			answered: false,
			startupUntil: Date.now() + this.startupTimeoutMs,
			client: Promise.resolve(undefined),
		};
		ws.client = LspClient.start(command, root, {
			onExit: (info) => this.exited(ws, command, info),
		}).then(
			(client) => (ws.started = client),
			() => {
				// Failed to start (a stub on PATH, a broken install): skip it quietly.
				this.disable(key);
				return undefined;
			},
		);
		this.workspaces.set(key, ws);
		return ws;
	}

	private exited(ws: Workspace, command: ServerCommand, info: ExitInfo): void {
		this.disable(ws.key);
		if (info.duringStart || this.closed) return;
		const how = info.signal ? `was killed (${info.signal})` : `exited with code ${info.code}`;
		const last = info.stderr.split("\n").at(-1)?.trim();
		this.warn(`${command.name} ${how}${last ? `: ${last}` : ""}. No code diagnostics from it for the rest of this session.`);
	}

	/** Names of the servers running now, without duplicates. */
	running(): string[] {
		const names = [...this.workspaces.values()].flatMap((ws) => (ws.started?.alive ? [ws.started.server.name] : []));
		return [...new Set(names)];
	}

	/** Servers running or starting (tests). */
	async clients(): Promise<LspClient[]> {
		const all = await Promise.all([...this.workspaces.values()].map((ws) => ws.client));
		return all.filter((c): c is LspClient => c !== undefined && c.alive);
	}

	/** Stop every server. With `final`, nothing starts afterwards. */
	async stopAll(final = false): Promise<void> {
		if (final) this.closed = true;
		const workspaces = [...this.workspaces.values()];
		this.workspaces.clear();
		// Not installed or broken servers may be fine after the user changed something.
		if (!final) this.disabled.clear();
		await Promise.all(workspaces.map(async (ws) => (await ws.client)?.stop()));
	}
}

/** `promise`, or undefined at `deadline` or on abort (the promise keeps running). */
function raceDeadline<T>(promise: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T | undefined> {
	return new Promise((resolve) => {
		const finish = (value: T | undefined) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			resolve(value);
		};
		const abort = () => finish(undefined);
		const timer = setTimeout(() => finish(undefined), Math.max(0, deadline - Date.now()));
		signal?.addEventListener("abort", abort, { once: true });
		promise.then(finish, () => finish(undefined));
	});
}

/** The block appended to the tool result for the model. Undefined when there is nothing to say. */
export function formatForModel(report: FileReport): string | undefined {
	if (report.fixed) return `<diagnostics file="${report.path}">\nNo errors.\n</diagnostics>`;
	if (report.total === 0) return undefined;
	const lines = report.errors.map((d) => `${position(d)} ${errorLabel(d)}: ${oneLine(d.message, 500)}${codeSuffix(d)}`);
	const more = report.total - report.errors.length;
	if (more > 0) lines.push(`+${more} more error${more === 1 ? "" : "s"}`);
	return `<diagnostics file="${report.path}">\n${lines.join("\n")}\n</diagnostics>`;
}

export function position(d: Diagnostic): string {
	return `${d.range.start.line + 1}:${d.range.start.character + 1}`;
}

/** "error TS2322" for TypeScript, like tsc prints it; "error" otherwise. */
function errorLabel(d: Diagnostic): string {
	const source = d.source?.toLowerCase();
	return typeof d.code === "number" && (source === "ts" || source === "typescript") ? `error TS${d.code}` : "error";
}

/** " (reportArgumentType)", " (E0308)": the code of other servers, after the message. */
function codeSuffix(d: Diagnostic): string {
	if (errorLabel(d) !== "error" || d.code === undefined || d.code === null || d.code === "") return "";
	return ` (${d.code})`;
}

export function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
