/**
 * The language servers wisp knows, how to find them, and which folder each one serves.
 *
 * Only servers already installed are used, never downloaded: a command on PATH, or for
 * TypeScript the project's own TypeScript 7 (whose compiler is its language server).
 *
 * No server may reach the network either. Each command carries what keeps it local: TypeScript's
 * automatic type acquisition (which runs `npm install @types/...`) is switched off, and gopls and
 * rust-analyzer get an environment in which go and cargo cannot download modules, crates or
 * toolchains. pyright and clangd do not fetch anything.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

export interface ServerCommand {
	command: string;
	args: string[];
	/** Shown to the user ("typescript-language-server", "TypeScript 7.0.2"). */
	name: string;
	/** Sent with initialize. */
	initializationOptions?: unknown;
	/** The workspace configuration, by section ("js/ts": {...}): answers workspace/configuration. */
	settings?: Record<string, unknown>;
	/** Added to the server's environment. */
	env?: Record<string, string>;
}

export interface ServerSpec {
	/** One server process per (id, root). */
	id: string;
	/** Lower-case file extensions, with the dot. */
	extensions: readonly string[];
	/** Files that mark the folder a server is started in, nearest first. */
	rootMarkers: readonly string[];
	languageId(file: string): string;
	/** The command to start for `root`, or undefined when none is installed. */
	resolve(root: string): ServerCommand | undefined;
	/** Commands this spec can use, for the settings row ("installed: ..."). */
	readonly commands: readonly string[];
}

const isWindows = process.platform === "win32";

/** Absolute path of `name` on PATH, or undefined. */
export function which(name: string, path = process.env.PATH ?? ""): string | undefined {
	const exts = isWindows ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	for (const dir of path.split(delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = join(dir, name + ext);
			try {
				accessSync(candidate, constants.X_OK);
				if (statSync(candidate).isFile()) return candidate;
			} catch {
				// Not here.
			}
		}
	}
	return undefined;
}

function onPath(name: string, args: string[], extra: Partial<ServerCommand> = {}): ServerCommand | undefined {
	const command = which(name);
	return command ? { command, args, name, ...extra } : undefined;
}

/** Any npm a server starts works from its cache only. */
const NPM_OFFLINE = { npm_config_offline: "true" };

/** TypeScript 7 (tsgo): automatic type acquisition off, through its workspace settings. */
const TSGO_LOCAL: Partial<ServerCommand> = {
	settings: {
		"js/ts": { tsserver: { automaticTypeAcquisition: { enabled: false } } },
		typescript: { disableAutomaticTypeAcquisition: true },
	},
	env: NPM_OFFLINE,
};

/** typescript-language-server: tsserver is started with --disableAutomaticTypingAcquisition. */
const TSLS_LOCAL: Partial<ServerCommand> = {
	initializationOptions: { disableAutomaticTypingAcquisition: true },
	env: NPM_OFFLINE,
};

/**
 * TypeScript 7 or newer installed in `root` or a parent folder: its `tsc --lsp --stdio` is the
 * language server and matches the compiler the project builds with.
 */
export function projectTypeScript(root: string): ServerCommand | undefined {
	for (let dir = resolve(root); ; dir = dirname(dir)) {
		const pkg = join(dir, "node_modules", "typescript");
		try {
			const { version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { version?: string };
			const major = Number(/^(\d+)\./.exec(version ?? "")?.[1]);
			// An older TypeScript serves through typescript-language-server, which finds it itself.
			if (major >= 7) {
				return { command: process.execPath, args: [join(pkg, "bin", "tsc"), "--lsp", "--stdio"], name: `TypeScript ${version}`, ...TSGO_LOCAL };
			}
			return undefined;
		} catch {
			// No TypeScript here.
		}
		if (dirname(dir) === dir) return undefined;
	}
}

const byExtension = (map: Record<string, string>, fallback: string) => (file: string) => map[extname(file).toLowerCase()] ?? fallback;

export const SERVERS: readonly ServerSpec[] = [
	{
		id: "typescript",
		extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
		rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
		languageId: byExtension(
			{ ".tsx": "typescriptreact", ".jsx": "javascriptreact", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript" },
			"typescript",
		),
		commands: ["typescript-language-server", "tsgo"],
		resolve: (root) =>
			projectTypeScript(root) ??
			onPath("typescript-language-server", ["--stdio"], TSLS_LOCAL) ??
			onPath("tsgo", ["--lsp", "--stdio"], TSGO_LOCAL),
	},
	{
		id: "python",
		extensions: [".py", ".pyi"],
		rootMarkers: ["pyrightconfig.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
		languageId: () => "python",
		commands: ["pyright-langserver", "basedpyright-langserver"],
		resolve: () => onPath("pyright-langserver", ["--stdio"]) ?? onPath("basedpyright-langserver", ["--stdio"]),
	},
	{
		id: "go",
		extensions: [".go"],
		rootMarkers: ["go.work", "go.mod"],
		languageId: () => "go",
		commands: ["gopls"],
		// gopls already runs go with GOPROXY=off by default; this also covers a toolchain download.
		resolve: () => onPath("gopls", [], { env: { GOPROXY: "off" } }),
	},
	{
		id: "rust",
		extensions: [".rs"],
		rootMarkers: ["Cargo.toml"],
		languageId: () => "rust",
		commands: ["rust-analyzer"],
		// cargo metadata / check would otherwise update the index and download crates.
		resolve: () => onPath("rust-analyzer", [], { env: { CARGO_NET_OFFLINE: "true", RUSTUP_AUTO_INSTALL: "0" } }),
	},
	{
		id: "c",
		extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx", ".m", ".mm"],
		rootMarkers: ["compile_commands.json", "compile_flags.txt", ".clangd", "CMakeLists.txt", "Makefile"],
		languageId: byExtension({ ".c": "c", ".h": "c", ".m": "objective-c", ".mm": "objective-cpp" }, "cpp"),
		commands: ["clangd"],
		resolve: () => onPath("clangd", []),
	},
];

export function specFor(file: string, specs: readonly ServerSpec[] = SERVERS): ServerSpec | undefined {
	const ext = extname(file).toLowerCase();
	return specs.find((spec) => spec.extensions.includes(ext));
}

/**
 * The folder a server for `file` runs in: the nearest parent with one of the spec's markers. With
 * none, `cwd` when the file is inside it, else the file's folder.
 */
export function findRoot(file: string, markers: readonly string[], cwd: string): string {
	for (let dir = dirname(resolve(file)); ; dir = dirname(dir)) {
		for (const marker of markers) {
			try {
				statSync(join(dir, marker));
				return dir;
			} catch {
				// Not here.
			}
		}
		if (dirname(dir) === dir) break;
	}
	const inside = relative(resolve(cwd), resolve(file));
	return inside && !inside.startsWith("..") && !isAbsolute(inside) ? resolve(cwd) : dirname(resolve(file));
}

const stubs = new Map<string, boolean>();
/**
 * rustup puts a rust-analyzer proxy on PATH that only works once the component is installed.
 * (Starting such a stub fails quietly anyway; this keeps it out of the settings row.)
 */
export function isRustupStub(path: string): boolean {
	let cached = stubs.get(path);
	if (cached === undefined) {
		let proxy = false;
		try {
			proxy = basename(realpathSync(path)).startsWith("rustup");
		} catch {
			// Unreadable: not a proxy.
		}
		cached = proxy && spawnSync(path, ["--version"], { timeout: 3000, stdio: "ignore" }).status !== 0;
		stubs.set(path, cached);
	}
	return cached;
}

/** Language-server commands found on PATH (for the settings row). */
export function installedServers(specs: readonly ServerSpec[] = SERVERS): string[] {
	return specs.flatMap((spec) =>
		spec.commands.filter((name) => {
			const path = which(name);
			return path !== undefined && !isRustupStub(path);
		}),
	);
}
