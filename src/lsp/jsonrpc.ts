/**
 * A minimal JSON-RPC 2.0 connection over a byte stream with LSP's framing:
 *
 *     Content-Length: <bytes>\r\n
 *     \r\n
 *     <JSON body of that many bytes, UTF-8>
 *
 * Just what a language-server client needs: requests with timeouts and abort, notifications,
 * and answering the server's own requests.
 */

import type { Readable, Writable } from "node:stream";

/** Largest message accepted (a misbehaving server must not exhaust memory). */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export type JsonRpcId = number | string;

export interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: JsonRpcId | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export const ErrorCodes = {
	MethodNotFound: -32601,
	InternalError: -32603,
	/** LSP: the server cancelled the request (pull diagnostics: try again). */
	ServerCancelled: -32802,
	RequestCancelled: -32800,
} as const;

export class ResponseError extends Error {
	readonly code: number;
	readonly data: unknown;
	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
	}
}

/** Frame one message. */
export function encodeMessage(message: JsonRpcMessage): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

const SEPARATOR = Buffer.from("\r\n\r\n", "ascii");

/**
 * Splits a byte stream into messages. Chunks may end anywhere, even inside a multi-byte
 * character or the header; Content-Length counts bytes, not characters.
 */
export class MessageReader {
	private buffer: Buffer = Buffer.alloc(0);
	/** Body length of the message being read, once its header is parsed. */
	private length: number | undefined;
	private readonly onMessage: (message: JsonRpcMessage) => void;
	private readonly onError: (error: Error) => void;

	constructor(onMessage: (message: JsonRpcMessage) => void, onError: (error: Error) => void = () => {}) {
		this.onMessage = onMessage;
		this.onError = onError;
	}

	push(chunk: Buffer): void {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		for (;;) {
			if (this.length === undefined) {
				const end = this.buffer.indexOf(SEPARATOR);
				if (end < 0) {
					if (this.buffer.length > 8192) {
						this.onError(new Error("LSP header too long"));
						this.buffer = Buffer.alloc(0);
					}
					return;
				}
				const header = this.buffer.subarray(0, end).toString("ascii");
				this.buffer = this.buffer.subarray(end + SEPARATOR.length);
				const match = /^content-length:\s*(\d+)\s*$/im.exec(header);
				if (!match) {
					this.onError(new Error(`LSP header without Content-Length: ${JSON.stringify(header)}`));
					continue;
				}
				const length = Number(match[1]);
				if (length > MAX_MESSAGE_BYTES) {
					// Unrecoverable: the body cannot be skipped without buffering it.
					this.onError(new Error(`LSP message too large (${length} bytes)`));
					this.buffer = Buffer.alloc(0);
					return;
				}
				this.length = length;
			}
			if (this.buffer.length < this.length) return;
			const body = this.buffer.subarray(0, this.length).toString("utf8");
			this.buffer = this.buffer.subarray(this.length);
			this.length = undefined;
			let message: JsonRpcMessage;
			try {
				message = JSON.parse(body) as JsonRpcMessage;
			} catch {
				this.onError(new Error("LSP message is not valid JSON"));
				continue;
			}
			if (message && typeof message === "object") this.onMessage(message);
		}
	}
}

export interface RequestOptions {
	/** Reject with a timeout error after this many milliseconds (and send $/cancelRequest). */
	timeoutMs?: number;
	signal?: AbortSignal;
}

type RequestHandler = (method: string, params: unknown) => unknown;
type NotificationHandler = (method: string, params: unknown) => void;

export class JsonRpcConnection {
	private nextId = 1;
	private readonly pending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private readonly output: Writable;
	private closed: Error | undefined;
	private requestHandler: RequestHandler = () => {
		throw new ResponseError(ErrorCodes.MethodNotFound, "Method not found");
	};
	private notificationHandler: NotificationHandler = () => {};

	constructor(input: Readable, output: Writable) {
		this.output = output;
		const reader = new MessageReader((message) => this.dispatch(message));
		input.on("data", (chunk: Buffer) => reader.push(chunk));
		input.on("end", () => this.close(new Error("Connection closed")));
		input.on("error", (error) => this.close(error));
		// A server that died leaves a broken pipe; the exit is reported elsewhere.
		output.on("error", (error) => this.close(error));
	}

	/** Answer the server's requests. Throw a ResponseError to reply with an error. */
	onRequest(handler: RequestHandler): void {
		this.requestHandler = handler;
	}

	onNotification(handler: NotificationHandler): void {
		this.notificationHandler = handler;
	}

	get isClosed(): boolean {
		return this.closed !== undefined;
	}

	request<T = unknown>(method: string, params: unknown, options: RequestOptions = {}): Promise<T> {
		if (this.closed) return Promise.reject(this.closed);
		if (options.signal?.aborted) return Promise.reject(new Error("Aborted"));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				this.pending.delete(id);
			};
			const cancel = (error: Error) => {
				cleanup();
				this.send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
				reject(error);
			};
			const onAbort = () => cancel(new Error("Aborted"));
			this.pending.set(id, {
				resolve: (value) => {
					cleanup();
					resolve(value as T);
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			});
			if (options.timeoutMs !== undefined) {
				timer = setTimeout(() => cancel(new Error(`${method} timed out after ${options.timeoutMs} ms`)), options.timeoutMs);
			}
			options.signal?.addEventListener("abort", onAbort, { once: true });
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	/** Reject everything pending; later requests fail at once. */
	close(reason: Error = new Error("Connection closed")): void {
		if (this.closed) return;
		this.closed = reason;
		for (const { reject } of [...this.pending.values()]) reject(reason);
		this.pending.clear();
	}

	private send(message: JsonRpcMessage): void {
		if (this.closed || this.output.destroyed || !this.output.writable) return;
		try {
			this.output.write(encodeMessage(message));
		} catch {
			// Reported through the stream's error event.
		}
	}

	private dispatch(message: JsonRpcMessage): void {
		if (message.method === undefined) {
			// A response.
			const waiter = message.id === undefined || message.id === null ? undefined : this.pending.get(message.id);
			if (!waiter) return;
			if (message.error) waiter.reject(new ResponseError(message.error.code, message.error.message, message.error.data));
			else waiter.resolve(message.result ?? null);
			return;
		}
		if (message.id === undefined || message.id === null) {
			try {
				this.notificationHandler(message.method, message.params);
			} catch {
				// A handler bug must not break the connection.
			}
			return;
		}
		const id = message.id;
		Promise.resolve()
			.then(() => this.requestHandler(message.method!, message.params))
			.then(
				(result) => this.send({ jsonrpc: "2.0", id, result: result ?? null }),
				(error: unknown) => {
					const code = error instanceof ResponseError ? error.code : ErrorCodes.InternalError;
					const text = error instanceof Error ? error.message : String(error);
					this.send({ jsonrpc: "2.0", id, error: { code, message: text } });
				},
			);
	}
}
