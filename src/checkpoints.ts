/**
 * File checkpoints in a shadow git repository (the engine behind /undo, /redo and restoring files
 * on /tree). Only Node and the git binary are used. The second half of this file is the
 * host-agnostic session layer: what to record, and the plans for /undo, /redo and /tree.
 *
 * Each project gets its own git directory under <wisp home>/checkpoints/<hash of the root>
 * (wisp home: $WISP_HOME, else ~/.wisp), used
 * with GIT_DIR=<that dir> and GIT_WORK_TREE=<project root>. A snapshot is a tree object
 * (update-index + write-tree; no commits, refs or hooks). The user's repository is only read:
 * its root, index and HEAD are looked up, and its object store is borrowed as an alternate for
 * reading (in the environment of each git call, not in a file), so the files of its HEAD are not
 * copied. Nothing in its .git is written, not even a timestamp:
 *
 * - Git refreshes the modification time of an object it is asked to write and finds in an
 *   alternate. So update-index and write-tree run without the alternate (anything they write goes
 *   to the shadow store), and a new shadow index starts as a copy of the user's HEAD tree
 *   (read-tree + refresh, which only read), so unchanged files are never hashed into the store.
 *
 * - A snapshot never depends on objects the user's repository could drop: after write-tree, every
 *   object the snapshot does not share with the user's HEAD and that only the user's store has (a
 *   staged blob, a tree of an amended commit) is copied into the shadow store.
 * - The root is the git toplevel when the folder is inside a repository, otherwise the folder.
 * - .gitignore files (and the repository's info/exclude) are respected, except for files the
 *   repository tracks anyway. Outside a repository a few dependency folders are skipped as well.
 *   Files over 2 MiB that git does not track are never added; capture() names them, so callers
 *   never restore a file whose earlier state was not saved.
 * - Restores never touch a file they cannot write back: every object is checked first, and files
 *   that already match the snapshot are left alone (and not reported).
 * - Git keeps only the executable bit; a snapshot also records each file's exact permission bits
 *   (Snapshot.perms), which restores put back when the caller passes them.
 * - A folder left empty by a restore is removed only if it was created after the snapshot being
 *   restored was taken (its birth time says so), so an empty folder that existed is kept.
 * - Git runs with no system or global config (so no user hooks, filters or fsmonitor), and with
 *   every attribute that could change file bytes switched off, so restores are byte-exact.
 * - Snapshots of one project run one at a time; every operation is best effort and reports
 *   failure as undefined or in its result instead of throwing.
 */

import { type SpawnOptions, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { appendFile, chmod, lstat, mkdir, readdir, readFile, readlink, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { devNull, homedir } from "node:os";
import { delimiter, dirname, join, parse, resolve, sep } from "node:path";

/** wisp's home folder: $WISP_HOME, else ~/.wisp (read on each call, so tests can set it). */
export function wispHome(): string {
	return process.env.WISP_HOME || join(homedir(), ".wisp");
}

/** Files git does not track that are larger than this are left out of snapshots. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Outside a git repository, a folder with more files than this is not snapshotted. */
export const MAX_UNTRACKED_FILES = 20_000;
/** Skipped outside a git repository (inside one, its .gitignore decides). */
const NON_GIT_EXCLUDES = ["node_modules/", ".venv/", "venv/", "__pycache__/", ".DS_Store"];
const TIMEOUT_MS = 120_000;

interface GitResult {
	code: number;
	stdout: Buffer;
	stderr: string;
}

/** The environment without the caller's GIT_* variables (a hook or alias could have set them). */
function cleanEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
	return { ...env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

function git(args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; input?: Buffer | string }): Promise<GitResult> {
	return new Promise((done) => {
		const spawnOptions: SpawnOptions = { cwd: options.cwd, env: options.env ?? cleanEnv(), stdio: ["pipe", "pipe", "pipe"] };
		let child;
		try {
			child = spawn("git", args, spawnOptions);
		} catch (error) {
			done({ code: -1, stdout: Buffer.alloc(0), stderr: String(error) });
			return;
		}
		const out: Buffer[] = [];
		let err = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
		child.stdout!.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr!.on("data", (chunk: Buffer) => (err += chunk.toString()));
		child.on("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			done({ code: error.code === "ENOENT" ? 127 : -1, stdout: Buffer.alloc(0), stderr: error.message });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			done({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err });
		});
		child.stdin!.on("error", () => {});
		child.stdin!.end(options.input ?? "");
	});
}

const nulList = (buffer: Buffer): string[] => buffer.toString("utf8").split("\0").filter(Boolean);
const nulInput = (paths: Iterable<string>): string => [...paths].map((p) => `${p}\0`).join("");

let gitCheck: Promise<boolean> | undefined;
/** Whether a git binary can be run (checked once per process). */
export function gitAvailable(): Promise<boolean> {
	gitCheck ??= git(["--version"], { cwd: process.cwd() }).then((r) => r.code === 0);
	return gitCheck;
}

/** Why a folder cannot have checkpoints, as a short user-facing sentence. */
export type Unavailable = { unavailable: string };

export interface Snapshot {
	/** The tree object. */
	tree: string;
	/** Files left out because they are too large: their state at this point is not saved. */
	skipped: string[];
	/** Permission bits of each regular file in the snapshot. */
	perms: Map<string, number>;
	/** When the snapshot was started (Date.now()). */
	at: number;
}

/** How a restore puts files back, beyond their content. */
export interface RestoreOptions {
	/** Exact permission bits by path (from the snapshot); other files keep theirs, with git's executable bit. */
	perms?: Readonly<Record<string, number>>;
	/** When the snapshot was taken: folders left empty are removed only if created after it. */
	at?: number;
}

export interface RestoreResult {
	/** Files written back (changed or re-created). */
	restored: string[];
	/** Files deleted because they did not exist at that point. */
	removed: string[];
	/** Files that could not be restored (left as they are). */
	failed: string[];
}

const GITLINK = "160000";

/** The object id git gives a blob with these bytes (the shadow repository uses SHA-1). */
function blobId(content: Buffer): string {
	return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

interface WorktreeEntry {
	mode: string;
	oid: string;
	/** A regular file's permission bits. */
	perm?: number;
}

/** Mode and blob id of a file in the work tree as git would record it, or undefined when absent. */
async function worktreeEntry(path: string): Promise<WorktreeEntry | undefined> {
	const info = await lstat(path).catch(() => undefined);
	if (!info) return undefined;
	if (info.isSymbolicLink()) {
		const target = await readlink(path, { encoding: "buffer" }).catch(() => undefined);
		return target ? { mode: "120000", oid: blobId(target) } : undefined;
	}
	if (!info.isFile()) return { mode: "dir", oid: "" };
	const content = await readFile(path).catch(() => undefined);
	if (!content) return { mode: "unreadable", oid: "" };
	return { mode: info.mode & 0o100 ? "100755" : "100644", oid: blobId(content), perm: info.mode & 0o7777 };
}

/**
 * The permission bits a file that had `perm` gets for git mode `mode`: the same, with the
 * executable bits set (where it is readable) or cleared. git itself writes 0666 or 0777 less the
 * umask, which can widen a private file's permissions.
 */
function permFor(perm: number, mode: string): number {
	return mode === "100755" ? perm | ((perm & 0o444) >> 2) : perm & ~0o111;
}

/** A value for GIT_ALTERNATE_OBJECT_DIRECTORIES (quoted when git would split or unquote it). */
function alternatesValue(dir: string): string {
	return dir.includes(delimiter) || dir.startsWith('"') ? JSON.stringify(dir) : dir;
}

/** Size (-1 when gone, 0 for a symlink) and a regular file's permission bits, of each path. */
async function statPaths(root: string, paths: readonly string[]): Promise<Array<{ size: number; perm?: number }>> {
	const out: Array<{ size: number; perm?: number }> = [];
	for (let i = 0; i < paths.length; i++) {
		// Synchronous lstat is several times faster here; yield now and then so the UI stays live.
		if (i % 500 === 499) await new Promise((done) => setImmediate(done));
		try {
			const info = lstatSync(join(root, paths[i]!));
			out.push({ size: info.isSymbolicLink() ? 0 : info.size, ...(info.isFile() ? { perm: info.mode & 0o7777 } : {}) });
		} catch {
			out.push({ size: -1 });
		}
	}
	return out;
}

function realpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** The shadow repository of one project root. Use ShadowRepo.open() (cached per root). */
export class ShadowRepo {
	readonly root: string;
	readonly gitDir: string;
	/** True when the root is a git repository (its .gitignore and objects are used). */
	readonly isGitRepo: boolean;
	/** The user's object store (git projects), borrowed as an alternate. */
	private readonly userObjects: string | undefined;
	private queue: Promise<unknown> = Promise.resolve();
	private restoreCount = 0;

	private constructor(root: string, gitDir: string, userObjects: string | undefined) {
		this.root = root;
		this.gitDir = gitDir;
		this.isGitRepo = userObjects !== undefined;
		this.userObjects = userObjects;
	}

	private static cache = new Map<string, Promise<ShadowRepo | Unavailable>>();

	/** The shadow repository for `cwd`, created on first use (under `agentDir`, default wisp home). */
	static open(cwd: string, agentDir: string = wispHome()): Promise<ShadowRepo | Unavailable> {
		const key = `${resolve(agentDir)}\0${resolve(cwd)}`;
		let repo = ShadowRepo.cache.get(key);
		if (!repo) {
			repo = ShadowRepo.create(cwd, agentDir);
			ShadowRepo.cache.set(key, repo);
			// A failure caused by something that can change (git installed, folder fixed) is retried later.
			void repo.then((r) => "unavailable" in r && ShadowRepo.cache.delete(key));
		}
		return repo;
	}

	private static async create(cwd: string, agentDir: string): Promise<ShadowRepo | Unavailable> {
		if (!(await gitAvailable())) return { unavailable: "git is not installed" };
		const dir = realpath(cwd);
		// Only read from the user's repository: where it is and where its objects live.
		const probe = await git(["rev-parse", "--show-toplevel", "--git-common-dir"], { cwd: dir });
		const [top, common] = probe.code === 0 ? probe.stdout.toString().trim().split("\n") : [];
		const isGitRepo = Boolean(top && common);
		const root = isGitRepo ? realpath(top!) : dir;
		if (!isGitRepo && (root === realpath(homedir()) || root === parse(root).root)) {
			return { unavailable: "this is your home folder or the filesystem root" };
		}

		const id = createHash("sha256").update(root).digest("hex").slice(0, 16);
		const gitDir = join(agentDir, "checkpoints", id);
		const repo = new ShadowRepo(root, gitDir, isGitRepo ? resolve(dir, common!, "objects") : undefined);
		try {
			if (!existsSync(join(gitDir, "HEAD"))) {
				await mkdir(gitDir, { recursive: true });
				const init = await git(["init", "--quiet", "--template="], { cwd: root, env: repo.env(false) });
				if (init.code !== 0) return { unavailable: `git init failed: ${init.stderr.trim()}` };
				await appendFile(
					join(gitDir, "config"),
					[
						"[core]",
						"\tbare = false",
						"\tautocrlf = false",
						"\tsafecrlf = false",
						"\tsymlinks = true",
						"\tfsmonitor = false",
						"\tuntrackedCache = false",
						"\tsplitIndex = false",
						"\tlongpaths = true",
						"[gc]",
						"\tauto = 0",
						"\tpruneExpire = never",
						"[maintenance]",
						"\tauto = false",
						"",
					].join("\n"),
				);
				await mkdir(join(gitDir, "info"), { recursive: true });
				// Highest-precedence attributes: no eol conversion, filters or ident expansion.
				await writeFile(join(gitDir, "info", "attributes"), "* -text !eol -ident -filter !working-tree-encoding\n");
				await writeFile(join(gitDir, "wisp-root"), `${root}\n`);
			}
			// The user's objects are an alternate only through the environment (see env()), so the
			// shadow store's own contents can be checked without them. Earlier versions used a file.
			await rm(join(gitDir, "objects", "info", "alternates"), { force: true });
			// Refreshed every run, so an edited info/exclude is followed.
			const exclude = isGitRepo
				? await readFile(resolve(dir, common!, "info", "exclude"), "utf8").catch(() => "")
				: `${NON_GIT_EXCLUDES.join("\n")}\n`;
			await writeFile(join(gitDir, "info", "exclude"), exclude);
		} catch (error) {
			return { unavailable: `cannot write ${gitDir}: ${(error as Error).message}` };
		}
		return repo;
	}

	private env(withWorkTree = true, indexFile?: string, ownObjectsOnly = false): NodeJS.ProcessEnv {
		return {
			...cleanEnv(),
			GIT_DIR: this.gitDir,
			...(withWorkTree ? { GIT_WORK_TREE: this.root } : {}),
			...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
			...(this.userObjects && !ownObjectsOnly ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternatesValue(this.userObjects) } : {}),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: devNull,
		};
	}

	private git(args: string[], input?: string, indexFile?: string): Promise<GitResult> {
		return git(args, { cwd: this.root, env: this.env(true, indexFile), input });
	}

	/** A git command that may write objects: without the user's store, so nothing there is touched. */
	private gitOwn(args: string[], input?: string): Promise<GitResult> {
		return git(args, { cwd: this.root, env: this.env(true, undefined, true), input });
	}

	/**
	 * Start a new shadow index from the user's HEAD tree, with stat data refreshed from the work
	 * tree: files that match HEAD are then known without hashing them into the shadow store.
	 */
	private async seedIndex(): Promise<void> {
		if (!this.isGitRepo || existsSync(join(this.gitDir, "index"))) return;
		const head = await this.userGit(["rev-parse", "-q", "--verify", "HEAD^{tree}"]);
		if (head.code !== 0) return;
		const read = await this.withIndexLock(() => this.git(["read-tree", head.stdout.toString().trim()]));
		if (read.code !== 0) return;
		// Exits non-zero when files differ from HEAD; those are hashed by the capture as usual.
		await this.withIndexLock(() => this.gitOwn(["update-index", "-q", "--refresh", "--ignore-missing", "--unmerged"]));
	}

	/** A read-only git command in the user's repository (no system or global config, no fsmonitor). */
	private userGit(args: string[]): Promise<GitResult> {
		const env = { ...cleanEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull };
		return git(["-c", "core.fsmonitor=false", ...args], { cwd: this.root, env });
	}

	/** Paths in the user's index (no submodules), or undefined when it cannot be read. */
	private async userTracked(extra: string[] = []): Promise<string[] | undefined> {
		const listed = await this.userGit(["ls-files", "-z", "--stage", ...extra]);
		if (listed.code !== 0) return undefined;
		const paths: string[] = [];
		for (const line of nulList(listed.stdout)) {
			const tab = line.indexOf("\t");
			if (tab > 0 && !line.startsWith(GITLINK)) paths.push(line.slice(tab + 1));
		}
		return paths;
	}

	/** Run snapshot work for this project one at a time. */
	private serial<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queue.then(task, task);
		this.queue = next.catch(() => undefined);
		return next;
	}

	/**
	 * Snapshot the files under the root. Undefined when the snapshot could not be taken (`onSkip`
	 * says why when the folder is too large).
	 */
	capture(onSkip?: (reason: string) => void): Promise<Snapshot | undefined> {
		return this.serial(async () => {
			const at = Date.now();
			await this.seedIndex();
			const changed = await this.git(["ls-files", "-z", "--modified", "--deleted"]);
			const untracked = await this.git(["ls-files", "-z", "--others", "--exclude-standard"]);
			if (changed.code !== 0 || untracked.code !== 0) return undefined;
			const candidates = nulList(untracked.stdout).filter((path) => !path.endsWith("/")); // nested repositories
			if (!this.isGitRepo && candidates.length > MAX_UNTRACKED_FILES) {
				onSkip?.(`more than ${MAX_UNTRACKED_FILES.toLocaleString("en-US")} files and no .gitignore`);
				return undefined;
			}
			const { small, large, perms } = await this.bySize(candidates);
			const paths = new Set([...nulList(changed.stdout), ...small]);
			let skipped = large;
			if (this.isGitRepo) {
				// Files the user's repository tracks are snapshotted whatever their size, and also when
				// a .gitignore matches them (force-added).
				const tracked = new Set(large.length > 0 ? ((await this.userTracked()) ?? []) : []);
				skipped = large.filter((path) => !tracked.has(path));
				for (const path of large) if (tracked.has(path)) paths.add(path);
				for (const path of (await this.userTracked(["--cached", "--ignored", "--exclude-standard"])) ?? []) paths.add(path);
			}
			if (paths.size > 0) {
				const update = await this.withIndexLock(() =>
					this.gitOwn(["update-index", "--add", "--remove", "--replace", "-z", "--stdin"], nulInput(paths)),
				);
				if (update.code !== 0) return undefined;
			}
			// --missing-ok: the blobs of unchanged files are in the user's store, out of sight here.
			const written = await this.withIndexLock(() => this.gitOwn(["write-tree", "--missing-ok"]));
			const tree = written.code === 0 ? written.stdout.toString().trim() : "";
			if (!tree || !(await this.ownCopy(tree))) return undefined;
			// The exact permission bits of the other files (git records only the executable bit).
			const listed = await this.git(["ls-files", "-z"]);
			if (listed.code !== 0) return undefined;
			const rest = nulList(listed.stdout).filter((path) => !perms.has(path));
			const stats = await statPaths(this.root, rest);
			rest.forEach((path, n) => stats[n]!.perm !== undefined && perms.set(path, stats[n]!.perm!));
			return { tree, skipped, perms, at };
		});
	}

	/**
	 * Copy into the shadow store the objects of `tree` that only the user's store has and that the
	 * user's HEAD does not hold (a staged file, an amended commit's tree): git may prune those. True
	 * when the snapshot is safe to use.
	 */
	private async ownCopy(tree: string): Promise<boolean> {
		if (!this.isGitRepo) return true;
		const head = await this.userGit(["rev-parse", "-q", "--verify", "HEAD^{tree}"]);
		const headTree = head.code === 0 ? head.stdout.toString().trim() : "";
		const ids = new Set([tree]);
		if (headTree) {
			// Raw -z output: ":<mode> <mode> <oid> <oid> <status>\0<path>\0" per changed entry.
			const diff = await this.git(["diff-tree", "-r", "-t", "-z", "--no-renames", headTree, tree]);
			if (diff.code !== 0) return false;
			const fields = nulList(diff.stdout);
			for (let i = 0; i + 1 < fields.length; i += 2) {
				const [, mode, , oid] = fields[i]!.slice(1).split(" ");
				if (mode && oid && mode !== "000000" && mode !== GITLINK) ids.add(oid);
			}
		} else {
			// "<mode> <type> <oid>\t<path>\0" per entry.
			const listed = await this.git(["ls-tree", "-r", "-t", "-z", tree]);
			if (listed.code !== 0) return false;
			for (const entry of nulList(listed.stdout)) {
				const [mode, type, oid] = entry.slice(0, entry.indexOf("\t")).split(" ");
				if (mode !== GITLINK && type !== "commit" && oid) ids.add(oid);
			}
		}
		return this.packMissing(ids);
	}

	/** Copy into the shadow store those of `ids` that only the user's store has. */
	private async packMissing(ids: Iterable<string>): Promise<boolean> {
		const list = [...ids];
		if (list.length === 0) return true;
		const own = await git(["cat-file", "--batch-check"], {
			cwd: this.root,
			env: this.env(true, undefined, true),
			input: list.join("\n") + "\n",
		});
		if (own.code !== 0) return false;
		const missing = own.stdout
			.toString()
			.split("\n")
			.filter((line) => line.endsWith(" missing"))
			.map((line) => line.slice(0, line.indexOf(" ")));
		if (missing.length === 0) return true;
		await mkdir(join(this.gitDir, "objects", "pack"), { recursive: true });
		const pack = await this.git(["pack-objects", "--quiet", join(this.gitDir, "objects", "pack", "pack")], missing.join("\n") + "\n");
		return pack.code === 0;
	}

	/**
	 * Paths that differ between two snapshots. Both versions of each, and the folders of both
	 * snapshots, are then kept in the shadow store too: they may have come from the user's commit,
	 * which an amend or rebase followed by `git gc` can remove.
	 */
	async changedFiles(from: string, to: string): Promise<string[] | undefined> {
		if (from === to) return [];
		// Raw -z output: ":<mode> <mode> <oid> <oid> <status>\0<path>\0" per changed file.
		const diff = await this.git(["diff-tree", "-r", "-z", "--no-renames", from, to]);
		if (diff.code !== 0) return undefined;
		const fields = nulList(diff.stdout);
		const paths: string[] = [];
		const ids = new Set<string>();
		for (let i = 0; i + 1 < fields.length; i += 2) {
			const [modeA, modeB, oidA, oidB] = fields[i]!.slice(1).split(" ");
			if (modeA !== "000000" && modeA !== GITLINK && oidA) ids.add(oidA);
			if (modeB !== "000000" && modeB !== GITLINK && oidB) ids.add(oidB);
			paths.push(fields[i + 1]!);
		}
		if (this.isGitRepo) {
			for (const tree of [from, to]) {
				// "<mode> tree <oid>\t<path>\0" per folder.
				const listed = await this.git(["ls-tree", "-r", "-d", "-z", tree]);
				if (listed.code !== 0) continue;
				for (const entry of nulList(listed.stdout)) {
					const [, type, oid] = entry.slice(0, entry.indexOf("\t")).split(" ");
					if (type === "tree" && oid) ids.add(oid);
				}
			}
			// Best effort: restoring checks for the content anyway and never writes what is missing.
			await this.packMissing(ids).catch(() => false);
		}
		return paths;
	}

	/**
	 * Put `paths` back to how they are in `tree`: write the ones it has, delete the ones it does
	 * not. Other files are left alone, and so are files that already match and files whose saved
	 * content is missing. A file that is rewritten keeps its permissions, apart from the
	 * executable bit. Uses a temporary index, so the snapshot index is untouched.
	 */
	async restore(tree: string, paths: readonly string[], options: RestoreOptions = {}): Promise<RestoreResult> {
		const result: RestoreResult = { restored: [], removed: [], failed: [] };
		if (paths.length === 0) return result;
		return this.withTempIndex(async (index) => {
			const compared = await this.compare(tree, paths, index, options.perms);
			if (!compared) return { ...result, failed: [...paths] };
			const { inTree, write, remove, chmodOnly, have } = compared;
			// Never replace a file with content that is not there to write.
			const check = write.length > 0 ? await this.git(["cat-file", "--batch-check"], write.map((p) => inTree.get(p)!.oid).join("\n") + "\n") : undefined;
			const lines = check?.stdout.toString().split("\n") ?? [];
			const writable = write.filter((path, n) => {
				const ok = check?.code === 0 && lines[n] !== undefined && !lines[n]!.endsWith(" missing");
				if (!ok) result.failed.push(path);
				return ok;
			});
			const written: string[] = [];
			if (writable.length > 0) {
				const out = await this.git(["checkout-index", "--force", "-z", "--stdin"], nulInput(writable), index);
				if (out.code === 0) written.push(...writable);
				else {
					// Find out which ones failed (for example a folder now where the file was).
					for (const path of writable) {
						const one = await this.git(["checkout-index", "--force", "--", path], undefined, index);
						(one.code === 0 ? written : result.failed).push(path);
					}
				}
			}
			for (const path of [...written, ...chmodOnly]) {
				// The snapshot's own permission bits when known, else the file's (git wrote 0666/0777 less the umask).
				const perm = options.perms?.[path] ?? have.get(path)?.perm;
				const mode = inTree.get(path)!.mode;
				if (perm !== undefined && mode !== "120000") {
					const absolute = join(this.root, path);
					const now = await lstat(absolute).catch(() => undefined);
					if (now?.isFile() && (now.mode & 0o7777) !== permFor(perm, mode)) {
						const ok = await chmod(absolute, permFor(perm, mode)).then(() => true, () => false);
						if (!ok && chmodOnly.includes(path)) {
							result.failed.push(path);
							continue;
						}
					}
				}
				result.restored.push(path);
			}
			for (const path of remove) {
				const absolute = join(this.root, path);
				try {
					await rm(absolute, { force: true });
					await this.removeEmptyParents(dirname(absolute), options.at);
					result.removed.push(path);
				} catch {
					result.failed.push(path);
				}
			}
			return result;
		});
	}

	/** Those of `paths` that `restore(tree, paths, options)` would change (all of them when unsure). */
	async differing(tree: string, paths: readonly string[], options: RestoreOptions = {}): Promise<string[]> {
		if (paths.length === 0) return [];
		return this.withTempIndex(async (index) => {
			const compared = await this.compare(tree, paths, index, options.perms);
			if (!compared) return [...paths];
			const changes = new Set([...compared.write, ...compared.remove, ...compared.chmodOnly]);
			return paths.filter((path) => changes.has(path));
		});
	}

	/** Run `use` with a temporary index file (removed afterwards), one operation at a time. */
	private withTempIndex<T>(use: (index: string) => Promise<T>): Promise<T> {
		return this.serial(async () => {
			const index = join(this.gitDir, `restore-${process.pid}-${++this.restoreCount}.index`);
			try {
				return await use(index);
			} finally {
				await rm(index, { force: true }).catch(() => undefined);
			}
		});
	}

	/**
	 * Which of `paths` differ from `tree` and have to be written or removed, or only need their
	 * permission bits put back (`perms`).
	 */
	private async compare(tree: string, paths: readonly string[], index: string, perms?: Readonly<Record<string, number>>) {
		const read = await this.git(["read-tree", tree], undefined, index);
		if (read.code !== 0) return undefined;
		const listed = await this.git(["ls-files", "-z", "--stage"], undefined, index);
		if (listed.code !== 0) return undefined;
		const inTree = new Map<string, { mode: string; oid: string }>();
		for (const line of nulList(listed.stdout)) {
			const tab = line.indexOf("\t");
			const [mode, oid] = line.slice(0, tab).split(" ");
			inTree.set(line.slice(tab + 1), { mode: mode!, oid: oid! });
		}
		const write: string[] = [];
		const remove: string[] = [];
		const chmodOnly: string[] = [];
		const have = new Map<string, WorktreeEntry>();
		for (const path of paths) {
			const want = inTree.get(path);
			const entry = await worktreeEntry(join(this.root, path));
			if (entry) have.set(path, entry);
			if (!want) {
				if (entry) remove.push(path);
			} else if (want.mode !== GITLINK && (entry?.mode !== want.mode || entry.oid !== want.oid)) {
				write.push(path);
			} else if (entry?.perm !== undefined && perms?.[path] !== undefined && entry.perm !== permFor(perms[path]!, want.mode)) {
				chmodOnly.push(path);
			}
		}
		return { inTree, write, remove, chmodOnly, have };
	}

	/** Candidates split into those small enough to snapshot and the rest, with the permission bits of the small ones. */
	private async bySize(paths: string[]): Promise<{ small: string[]; large: string[]; perms: Map<string, number> }> {
		const small: string[] = [];
		const large: string[] = [];
		const perms = new Map<string, number>();
		const stats = await statPaths(this.root, paths);
		paths.forEach((path, n) => {
			const { size, perm } = stats[n]!;
			if (size > MAX_FILE_BYTES) large.push(path);
			else if (size >= 0) {
				small.push(path); // (-1: gone since it was listed)
				if (perm !== undefined) perms.set(path, perm);
			}
		});
		return { small, large, perms };
	}

	/** Retry while another wisp holds the snapshot index; clear a lock left by a crash. */
	private async withIndexLock(run: () => Promise<GitResult>): Promise<GitResult> {
		const lock = join(this.gitDir, "index.lock");
		for (let attempt = 0; ; attempt++) {
			const result = await run();
			if (result.code === 0 || !/index\.lock/.test(result.stderr) || attempt >= 20) return result;
			const info = await stat(lock).catch(() => undefined);
			if (info && Date.now() - info.mtimeMs > 60_000) await rm(lock, { force: true }).catch(() => undefined);
			await new Promise((done) => setTimeout(done, 100));
		}
	}

	/**
	 * Remove folders left empty by deleting a file, up to the root: with `at`, only those created
	 * after it (a folder that existed then, empty, stays; so does one whose birth time is unknown).
	 */
	private async removeEmptyParents(dir: string, at?: number): Promise<void> {
		while (dir.startsWith(this.root + sep)) {
			const entries = await readdir(dir).catch(() => undefined);
			if (!entries || entries.length > 0) return;
			if (at !== undefined) {
				const born = (await stat(dir).catch(() => undefined))?.birthtimeMs;
				if (!born || born <= at) return;
			}
			await rmdir(dir).catch(() => undefined);
			dir = dirname(dir);
		}
	}
}

// ---------------------------------------------------------------------------------------------
// Session layer: host-agnostic. The host gives a log of entries (its session) and a way to append
// one; PromptCheckpoints does the rest.
//
// - beginPrompt(): a "before" snapshot is taken in the background while the model thinks.
// - beforeToolCall(name): the first call that can change files (anything but READ_ONLY_TOOLS) waits
//   for it and saves it at once as a START_ENTRY, so a prompt cut short by a crash can be undone.
// - settle(): the "after" snapshot; if files changed, a CHECKPOINT_ENTRY records both snapshots and
//   the changed paths, anchored at the leaf the run ended on (so it belongs to that branch).
// - recover(): on session start, start entries no checkpoint completes are recorded from the files
//   as they are now.
// - undo()/redo(): stacks, derived from the branch (checkpointHistory); they append UNDO_ENTRY /
//   REDO_ENTRY and return a message for the user and a note for the model.
// - treePlan()/restoreTo(): moving the conversation with /tree restores files between two leaves.
// ---------------------------------------------------------------------------------------------

export const CHECKPOINT_ENTRY = "wisp-checkpoint";
/** The snapshot before a prompt's first change, saved as soon as it is taken. */
export const START_ENTRY = "wisp-checkpoint-start";
export const UNDO_ENTRY = "wisp-checkpoint-undo";
export const REDO_ENTRY = "wisp-checkpoint-redo";
/** Marks where /tree left the conversation after restoring files, so a restart resumes there. */
export const TREE_RESTORE_ENTRY = "wisp-checkpoint-tree";

/** Tools that cannot change files. Every other tool call (bash included) is preceded by a snapshot. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "read_file", "grep", "find", "glob", "ls", "todo", "subagent"]);

export interface StartData {
	v: 1;
	root: string;
	/** Snapshot before the prompt changed anything, and when it was taken. */
	before: string;
	at: number;
	/** Files too large to snapshot. */
	skipped?: string[];
}

/** Exact permission bits by path. */
export type Perms = Record<string, number>;

export interface CheckpointData {
	v: 1;
	/** Project root the paths are relative to. */
	root: string;
	/** Snapshot before the prompt changed anything, and after its run. */
	before: string;
	after: string;
	/** Paths that differ between the two. */
	files: string[];
	/** Paths that changed too but are too large to snapshot (left alone by undo). */
	tooLarge?: string[];
	/** The last entry of the run (the leaf when it settled). */
	anchor: string;
	/** The start entry this completes. */
	start?: string;
	beforeAt?: number;
	afterAt?: number;
	/** Permission bits of `files` in the two snapshots (regular files only). */
	perms?: { before: Perms; after: Perms };
}
export interface UndoData {
	v: 1;
	checkpoint: string;
	/** Snapshot of the files just before the undo, restored by redo. */
	redo: string;
	/** The files undone, when not all of the checkpoint's. */
	files?: string[];
	redoAt?: number;
	redoPerms?: Perms;
}
export interface RedoData {
	v: 1;
	checkpoint: string;
}

export interface Checkpoint extends CheckpointData {
	/** Entry id of the checkpoint. */
	id: string;
}

export interface CheckpointHistory {
	/** Checkpoints in effect, oldest first: undo takes the last. */
	done: Checkpoint[];
	/** Undone checkpoints, oldest first: redo takes the last (`files`: what the undo restored). */
	undone: Array<{ checkpoint: Checkpoint; redo: Source; files: string[] }>;
}

/** A snapshot to restore files from: its tree, and what restores need beyond content. */
export interface Source {
	tree: string;
	perms?: Perms;
	at?: number;
}

/**
 * One entry of the host's session log. A checkpoint entry is one whose `type` is the entry kind
 * (e.g. CHECKPOINT_ENTRY), or `type: "custom"` with the kind in `customType`.
 */
export interface LogEntry {
	id: string;
	type: string;
	customType?: string;
	data?: unknown;
}

/** The host's session, as far as checkpoints need it. */
export interface CheckpointLog {
	/** Every entry, on every branch. */
	getEntries(): readonly LogEntry[];
	/** The entries from the root to `leafId` (default: the current leaf), oldest first. */
	getBranch(leafId?: string): readonly LogEntry[];
}

const beforeOf = (c: CheckpointData): Source => ({ tree: c.before, perms: c.perms?.before, at: c.beforeAt });
const afterOf = (c: CheckpointData): Source => ({ tree: c.after, perms: c.perms?.after, at: c.afterAt });

function dataOf<T>(entry: LogEntry, kind: string): T | undefined {
	const k = entry.type === "custom" ? entry.customType : entry.type;
	return k === kind && entry.data && typeof entry.data === "object" ? (entry.data as T) : undefined;
}

function checkpointOf(entry: LogEntry): CheckpointData | undefined {
	const data = dataOf<Partial<CheckpointData>>(entry, CHECKPOINT_ENTRY);
	return typeof data?.before === "string" &&
		typeof data.after === "string" &&
		typeof data.anchor === "string" &&
		typeof data.root === "string" &&
		Array.isArray(data.files)
		? (data as CheckpointData)
		: undefined;
}

/**
 * The checkpoints in effect at `leafId` (default: the current leaf; null: the start of the
 * conversation), for the project at `root`. A checkpoint counts once its anchor is on the branch;
 * undo and redo entries on the branch take it out or put it back.
 */
export function checkpointHistory(log: CheckpointLog, root: string, leafId?: string | null): CheckpointHistory {
	const byAnchor = new Map<string, Checkpoint[]>();
	for (const entry of log.getEntries()) {
		const data = checkpointOf(entry);
		if (!data || data.root !== root) continue;
		const list = byAnchor.get(data.anchor) ?? [];
		list.push({ ...data, id: entry.id });
		byAnchor.set(data.anchor, list);
	}
	const history: CheckpointHistory = { done: [], undone: [] };
	const path = leafId === null ? [] : log.getBranch(leafId);
	for (const entry of path) {
		for (const checkpoint of byAnchor.get(entry.id) ?? []) {
			history.done.push(checkpoint);
			// New changes end what redo could bring back.
			history.undone = [];
		}
		const undo = dataOf<UndoData>(entry, UNDO_ENTRY);
		if (undo) {
			const at = history.done.findLastIndex((c) => c.id === undo.checkpoint);
			if (at >= 0) {
				const checkpoint = history.done.splice(at, 1)[0]!;
				const files = Array.isArray(undo.files) ? undo.files : checkpoint.files;
				history.undone.push({ checkpoint, redo: { tree: undo.redo, perms: undo.redoPerms, at: undo.redoAt }, files });
			}
		}
		const redo = dataOf<RedoData>(entry, REDO_ENTRY);
		if (redo) {
			const at = history.undone.findLastIndex((u) => u.checkpoint.id === redo.checkpoint);
			if (at >= 0) history.done.push(history.undone.splice(at, 1)[0]!.checkpoint);
		}
	}
	return history;
}

/**
 * Which snapshot each file has to come from to move the files from the checkpoints in effect at
 * `from` to those in effect at `to` (leaf ids; null is the start of the conversation).
 */
export function restorePlan(log: CheckpointLog, root: string, from: string | null, to: string | null): Map<string, Source> {
	const a = checkpointHistory(log, root, from).done;
	const b = checkpointHistory(log, root, to).done;
	const inA = new Set(a.map((c) => c.id));
	const inB = new Set(b.map((c) => c.id));
	const plan = new Map<string, Source>();
	for (const checkpoint of a) {
		if (inB.has(checkpoint.id)) continue;
		const source = beforeOf(checkpoint);
		for (const file of checkpoint.files) if (!plan.has(file)) plan.set(file, source);
	}
	for (const checkpoint of b) {
		if (inA.has(checkpoint.id)) continue;
		const source = afterOf(checkpoint);
		for (const file of checkpoint.files) plan.set(file, source);
	}
	return plan;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "restored 2 files and removed 1 (a.ts, b.ts, new.ts)" */
export function describeRestore(result: RestoreResult): string {
	const parts: string[] = [];
	if (result.restored.length > 0) parts.push(`restored ${plural(result.restored.length, "file")}`);
	if (result.removed.length > 0) {
		parts.push(result.restored.length > 0 ? `removed ${result.removed.length}` : `removed ${plural(result.removed.length, "file")}`);
	}
	const names = [...result.restored, ...result.removed];
	const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
	let text = parts.length > 0 ? `${parts.join(" and ")} (${shown})` : "no files needed restoring";
	if (result.failed.length > 0) text += `; could not restore ${result.failed.slice(0, 3).join(", ")}`;
	return text;
}

function bySource(plan: Map<string, Source>): Map<Source, string[]> {
	const out = new Map<Source, string[]>();
	for (const [file, source] of plan) out.set(source, [...(out.get(source) ?? []), file]);
	return out;
}

/** The part of a plan that would change something: files already as they were are left out. */
export async function pendingPlan(repo: ShadowRepo, plan: Map<string, Source>): Promise<Map<string, Source>> {
	const pending = new Map<string, Source>();
	for (const [source, files] of bySource(plan)) {
		for (const file of await repo.differing(source.tree, files, source)) pending.set(file, source);
	}
	return pending;
}

/** Restore every file of a plan, one snapshot at a time. */
export async function applyPlan(repo: ShadowRepo, plan: Map<string, Source>): Promise<RestoreResult> {
	const total: RestoreResult = { restored: [], removed: [], failed: [] };
	for (const [source, files] of bySource(plan)) {
		const result = await repo.restore(source.tree, files, source);
		total.restored.push(...result.restored);
		total.removed.push(...result.removed);
		total.failed.push(...result.failed);
	}
	return total;
}

/**
 * Take the "after" snapshot and build the checkpoint between `before` and it, anchored at
 * `anchor`; undefined when nothing restorable changed (or a snapshot failed).
 */
export async function buildCheckpoint(
	repo: ShadowRepo,
	before: Snapshot | Omit<Snapshot, "perms">,
	anchor: string,
	start?: string,
): Promise<CheckpointData | undefined> {
	const after = await repo.capture();
	if (!after) return undefined;
	const changed = await repo.changedFiles(before.tree, after.tree);
	if (!changed) return undefined;
	const unsaved = new Set([...before.skipped, ...after.skipped]);
	const beforePerms = "perms" in before ? before.perms : undefined;
	// Permission changes git does not see (it keeps only the executable bit).
	const chmodded = beforePerms
		? [...after.perms].filter(([file, perm]) => beforePerms.has(file) && beforePerms.get(file) !== perm).map(([file]) => file)
		: [];
	const all = [...new Set([...changed, ...chmodded])];
	const files = all.filter((file) => !unsaved.has(file));
	if (files.length === 0) return undefined;
	const tooLarge = all.filter((file) => unsaved.has(file));
	const pick = (perms: Map<string, number>) => Object.fromEntries(files.flatMap((f) => (perms.has(f) ? [[f, perms.get(f)!]] : [])));
	return {
		v: 1,
		root: repo.root,
		before: before.tree,
		after: after.tree,
		files,
		anchor,
		...(start ? { start } : {}),
		beforeAt: before.at,
		afterAt: after.at,
		...(beforePerms ? { perms: { before: pick(beforePerms), after: pick(after.perms) } } : {}),
		...(tooLarge.length > 0 ? { tooLarge } : {}),
	};
}

export interface CheckpointHost {
	/** The session's working folder. */
	cwd: string;
	/** Where shadow repositories live (default: wispHome()). */
	agentDir?: string;
	log: CheckpointLog;
	/** The current leaf id (null: empty conversation). */
	leafId(): string | null;
	/** Append an entry of `kind` with `data` at the leaf; returns its id. */
	append(kind: string, data: unknown): string | undefined;
	/** A one-time warning (checkpoints unavailable here, files skipped). */
	warn?(message: string): void;
}

/** What /undo or /redo did: a message for the user, and (when files changed) a note for the model. */
export interface CommandOutcome {
	ok: boolean;
	level: "info" | "warning" | "error";
	message: string;
	/** For a hidden message to the model, set when files were changed back. */
	modelNote?: string;
	result?: RestoreResult;
}

interface Run {
	repo: Promise<ShadowRepo | undefined>;
	before: Promise<Snapshot | undefined>;
	mutated: boolean;
	start?: string;
}

/** Per-session checkpoint recorder and /undo, /redo, /tree driver. */
export class PromptCheckpoints {
	private run: Run | undefined;
	private recording: Promise<void> = Promise.resolve();
	private warned = new Set<string>();

	private readonly host: CheckpointHost;

	constructor(host: CheckpointHost) {
		this.host = host;
	}

	private warn(key: string, message: string) {
		if (this.warned.has(key)) return;
		this.warned.add(key);
		this.host.warn?.(message);
	}

	/** The shadow repository for the session's folder, or undefined (with a one-time warning). */
	async repo(): Promise<ShadowRepo | undefined> {
		const repo = await ShadowRepo.open(this.host.cwd, this.host.agentDir).catch((error: Error) => ({ unavailable: error.message }));
		if (!("unavailable" in repo)) return repo;
		this.warn(`open:${repo.unavailable}`, `Checkpoints are off here: ${repo.unavailable}. /undo and /redo will not work.`);
		return undefined;
	}

	private startRun(): Run {
		const repo = this.repo();
		const before = repo.then((r) => r?.capture((reason) => this.warn(`skip:${r.root}`, `Checkpoints are paused in ${r.root}: ${reason}.`)));
		return { repo, before: before.catch(() => undefined), mutated: false };
	}

	/** A prompt starts: snapshot in the background while the model works on its first response. */
	beginPrompt(): void {
		this.run ??= this.startRun();
	}

	/**
	 * Await before running a tool. For a tool that can change files, waits for the "before"
	 * snapshot and, the first time in the prompt, saves it as a START_ENTRY.
	 */
	async beforeToolCall(toolName: string): Promise<void> {
		if (READ_ONLY_TOOLS.has(toolName)) return;
		this.run ??= this.startRun();
		const current = this.run;
		current.mutated = true;
		const before = await current.before;
		if (!before || current.start !== undefined || this.run !== current) return;
		const repo = await current.repo;
		if (!repo || current.start !== undefined || this.run !== current) return;
		const data: StartData = { v: 1, root: repo.root, before: before.tree, at: before.at, ...(before.skipped.length > 0 ? { skipped: before.skipped } : {}) };
		current.start = this.host.append(START_ENTRY, data) ?? this.host.leafId() ?? undefined;
	}

	/** The run settled (or was interrupted): record its checkpoint, anchored at the current leaf, in the background. */
	settle(): void {
		const finished = this.run;
		this.run = undefined;
		if (!finished?.mutated) return;
		const anchor = this.host.leafId();
		this.recording = this.recording
			.then(async () => {
				const [repo, before] = await Promise.all([finished.repo, finished.before]);
				if (!repo || !before || !anchor) return;
				const data = await buildCheckpoint(repo, before, anchor, finished.start);
				if (data) this.host.append(CHECKPOINT_ENTRY, data);
			})
			.catch(() => undefined);
	}

	/** Wait for background recording (bounded by `timeoutMs` when given, e.g. on exit). */
	flush(timeoutMs?: number): Promise<void> {
		if (timeoutMs === undefined) return this.recording;
		return Promise.race([this.recording, new Promise<void>((done) => setTimeout(done, timeoutMs).unref())]);
	}

	/** On session start: record runs whose process died after their START_ENTRY. */
	recover(): void {
		const log = this.host.log;
		const done = new Set<string>();
		const starts: Array<{ id: string; data: StartData }> = [];
		for (const entry of log.getEntries()) {
			const start = dataOf<StartData>(entry, START_ENTRY);
			if (start && typeof start.before === "string" && typeof start.root === "string") starts.push({ id: entry.id, data: start });
			const checkpoint = dataOf<CheckpointData>(entry, CHECKPOINT_ENTRY);
			if (typeof checkpoint?.start === "string") done.add(checkpoint.start);
		}
		const open = starts.filter((s) => !done.has(s.id));
		if (open.length === 0) return;
		const onBranch = new Set(log.getBranch().map((e) => e.id));
		const leaf = this.host.leafId();
		this.recording = this.recording
			.then(async () => {
				const repo = await this.repo();
				if (!repo) return;
				for (const { id, data } of open) {
					if (data.root !== repo.root) continue;
					const anchor = onBranch.has(id) && leaf ? leaf : id;
					const checkpoint = await buildCheckpoint(repo, { tree: data.before, skipped: data.skipped ?? [], at: data.at }, anchor, id);
					if (checkpoint) this.host.append(CHECKPOINT_ENTRY, checkpoint);
				}
			})
			.catch(() => undefined);
	}

	private async ready(): Promise<ShadowRepo | CommandOutcome> {
		await this.recording;
		const repo = await ShadowRepo.open(this.host.cwd, this.host.agentDir).catch((error: Error) => ({ unavailable: error.message }));
		if ("unavailable" in repo) return { ok: false, level: "warning", message: `Checkpoints are off here: ${repo.unavailable}.` };
		return repo;
	}

	private static noteFor(text: string, result: RestoreResult): string {
		const files = [...result.restored, ...result.removed];
		const list = files.slice(0, 50).join(", ") + (files.length > 50 ? `, and ${files.length - 50} more` : "");
		return `${text} Files affected: ${list}.`;
	}

	/** /undo: put back the files the last checkpointed prompt on this branch changed. Call when idle. */
	async undo(): Promise<CommandOutcome> {
		const repo = await this.ready();
		if (!(repo instanceof ShadowRepo)) return repo;
		const history = checkpointHistory(this.host.log, repo.root);
		const checkpoint = history.done.at(-1);
		if (!checkpoint) {
			const message =
				history.undone.length > 0 ? "Nothing left to undo (/redo brings changes back)." : "Nothing to undo: no prompt in this conversation changed files.";
			return { ok: true, level: "info", message };
		}
		const redo = await repo.capture();
		if (!redo) return { ok: false, level: "error", message: "Could not snapshot the current files, so nothing was undone." };
		const unsaved = new Set(redo.skipped);
		const files = checkpoint.files.filter((file) => !unsaved.has(file));
		const result = await repo.restore(checkpoint.before, files, beforeOf(checkpoint));
		for (const file of checkpoint.files) if (unsaved.has(file)) result.failed.push(file);
		if (result.failed.length > 0 && result.restored.length + result.removed.length === 0) {
			return { ok: false, level: "error", message: `Could not restore ${result.failed.slice(0, 3).join(", ")}, so nothing was undone.`, result };
		}
		const data: UndoData = {
			v: 1,
			checkpoint: checkpoint.id,
			redo: redo.tree,
			...(files.length < checkpoint.files.length ? { files } : {}),
			redoAt: redo.at,
			redoPerms: Object.fromEntries(files.flatMap((f) => (redo.perms.has(f) ? [[f, redo.perms.get(f)!]] : []))),
		};
		this.host.append(UNDO_ENTRY, data);
		const large = checkpoint.tooLarge ?? [];
		const note = large.length > 0 ? ` Left as is (over 2 MiB, not snapshotted): ${large.slice(0, 3).join(", ")}${large.length > 3 ? ` and ${large.length - 3} more` : ""}.` : "";
		return {
			ok: true,
			level: result.failed.length || note ? "warning" : "info",
			message: `Undo: ${describeRestore(result)}. /redo brings the changes back.${note}`,
			modelNote: PromptCheckpoints.noteFor("The user ran /undo: the file changes from their previous request were reverted.", result),
			result,
		};
	}

	/** /redo: bring back what the last /undo on this branch reverted. Call when idle. */
	async redo(): Promise<CommandOutcome> {
		const repo = await this.ready();
		if (!(repo instanceof ShadowRepo)) return repo;
		const last = checkpointHistory(this.host.log, repo.root).undone.at(-1);
		if (!last) return { ok: true, level: "info", message: "Nothing to redo." };
		const result = await repo.restore(last.redo.tree, last.files, last.redo);
		if (result.failed.length > 0 && result.restored.length + result.removed.length === 0) {
			return { ok: false, level: "error", message: `Could not restore ${result.failed.slice(0, 3).join(", ")}, so nothing was redone.`, result };
		}
		const data: RedoData = { v: 1, checkpoint: last.checkpoint.id };
		this.host.append(REDO_ENTRY, data);
		return {
			ok: true,
			level: result.failed.length ? "warning" : "info",
			message: `Redo: ${describeRestore(result)}.`,
			modelNote: PromptCheckpoints.noteFor("The user ran /redo: the file changes /undo had reverted are back.", result),
			result,
		};
	}

	/**
	 * Before /tree moves from the current leaf to `to`: the files a restore would change (empty:
	 * do not ask). Show its size in "Restore files to that point too?".
	 */
	async treePlan(to: string | null): Promise<Map<string, Source>> {
		await this.recording;
		const repo = await this.repo();
		if (!repo) return new Map();
		return pendingPlan(repo, restorePlan(this.host.log, repo.root, this.host.leafId(), to));
	}

	/**
	 * After /tree moved from `from` to `to` (where it really ended) and the user said yes: restore
	 * the files, and mark the spot with a TREE_RESTORE_ENTRY when anything changed.
	 */
	async restoreTo(from: string | null, to: string | null): Promise<RestoreResult> {
		const run = this.recording.then(async () => {
			const repo = await this.repo();
			if (!repo) return { restored: [], removed: [], failed: [] };
			const result = await applyPlan(repo, restorePlan(this.host.log, repo.root, from, to));
			if (result.restored.length + result.removed.length > 0) this.host.append(TREE_RESTORE_ENTRY, { v: 1 });
			return result;
		});
		this.recording = run.then(() => undefined, () => undefined);
		return run;
	}
}
