/**
 * Checkpoints: the shadow git repository (real git in temp folders), the
 * branch-aware history, and the feature driven through wisp's Agent with
 * real tools: /undo, /redo, restoring files on /tree, crash recovery.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHECKPOINT_ENTRY, checkpointHistory, describeRestore, MAX_FILE_BYTES, ShadowRepo, START_ENTRY } from "../src/checkpoints.ts";
import { Agent } from "../src/core/agent.ts";
import type { FeatureUI } from "../src/core/hooks.ts";
import { modelInfo } from "../src/core/models.ts";
import { logAgentEvent, restore, Session } from "../src/core/session.ts";
import { SettingsStore } from "../src/core/settings.ts";
import type { CompletionRequest, CompletionResult, Message, Provider } from "../src/core/types.ts";
import { checkpointLog, checkpointsFeature } from "../src/features/checkpoints.ts";
import { installFeatures } from "../src/features/index.ts";
import { ALL_TOOLS } from "../src/tools/index.ts";

function tempDirs() {
	const root = mkdtempSync(join(tmpdir(), "wisp-cp-"));
	const agentDir = join(root, "home");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return { root, agentDir, cwd };
}

const write = (root: string, path: string, content: string) => {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), content);
};
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");
const gitIn = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

function userRepo(cwd: string) {
	gitIn(cwd, "init", "-q");
	write(cwd, "a.txt", "a1\n");
	write(cwd, "b.txt", "b1\n");
	write(cwd, "src/c.ts", "export const c = 1;\n");
	write(cwd, ".gitignore", "secret.env\nbuild/\n");
	gitIn(cwd, "add", ".");
	gitIn(cwd, "commit", "-qm", "init");
}

/** Everything about the user's repository that checkpoints must never change. */
function repoState(cwd: string) {
	const hash = (path: string) => (existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "none");
	const objects = (dir: string): string[] =>
		readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? objects(join(dir, e.name)) : [join(dir, e.name)]));
	return {
		index: hash(join(cwd, ".git", "index")),
		refs: gitIn(cwd, "for-each-ref"),
		head: gitIn(cwd, "rev-parse", "HEAD"),
		stash: gitIn(cwd, "stash", "list"),
		config: hash(join(cwd, ".git", "config")),
		objects: objects(join(cwd, ".git", "objects")).sort(),
		// Git refreshes the time of an object it is asked to write and finds in an alternate.
		mtimes: objects(join(cwd, ".git", "objects")).map((file) => `${file} ${statSync(file).mtimeMs}`).sort(),
	};
}

async function open(cwd: string, agentDir: string): Promise<ShadowRepo> {
	const repo = await ShadowRepo.open(cwd, agentDir);
	if ("unavailable" in repo) throw new Error(repo.unavailable);
	return repo;
}

test("shadow repo in a git project: created, modified, deleted and bash-made files; the user's .git untouched", async () => {
	const { agentDir, cwd } = tempDirs();
	userRepo(cwd);
	// Packed objects and loose ones (a second commit after gc).
	gitIn(cwd, "gc", "-q");
	write(cwd, "b.txt", "b1\n");
	write(cwd, "src/c.ts", "export const c = 1;\n");
	write(cwd, "z.txt", "z\n");
	gitIn(cwd, "add", ".");
	gitIn(cwd, "commit", "-qm", "loose");
	const before = repoState(cwd);
	const repo = await open(cwd, agentDir);
	assert.equal(repo.root, cwd);
	assert.ok(repo.gitDir.startsWith(join(agentDir, "checkpoints")));
	// The user's objects are borrowed through the environment, not a file in the shadow store.
	assert.equal(existsSync(join(repo.gitDir, "objects", "info", "alternates")), false);

	write(cwd, "secret.env", "TOKEN=1\n");
	const t1 = (await repo.capture())!.tree;
	assert.match(t1, /^[0-9a-f]{40}$/);

	write(cwd, "a.txt", "a2\n"); // modified
	rmSync(join(cwd, "b.txt")); // deleted
	write(cwd, "new/deep/n.txt", "new\n"); // created in new folders
	write(cwd, "secret.env", "TOKEN=2\n"); // gitignored: never touched
	write(cwd, "build/out.js", "x"); // gitignored folder
	write(cwd, "big.bin", "x".repeat(MAX_FILE_BYTES + 1)); // too large to snapshot
	execFileSync("sh", ["-c", "sed -i 's/1/2/' src/c.ts && printf 'made by bash\\n' > bash.txt"], { cwd }); // what bash does
	const t2 = (await repo.capture())!.tree;
	const files = (await repo.changedFiles(t1, t2))!.sort();
	assert.deepEqual(files, ["a.txt", "b.txt", "bash.txt", "new/deep/n.txt", "src/c.ts"]);
	// Content the user's store already has (a.txt as committed) is hashed into the shadow store only.
	write(cwd, "z.txt", "a1\n");
	assert.ok(await repo.capture());
	await repo.restore(t2, ["z.txt"]);
	assert.equal(read(cwd, "z.txt"), "z\n");

	const result = await repo.restore(t1, files);
	assert.deepEqual(result.restored.sort(), ["a.txt", "b.txt", "src/c.ts"]);
	assert.deepEqual(result.removed.sort(), ["bash.txt", "new/deep/n.txt"]);
	assert.deepEqual(result.failed, []);
	assert.equal(read(cwd, "a.txt"), "a1\n");
	assert.equal(read(cwd, "b.txt"), "b1\n");
	assert.equal(read(cwd, "src/c.ts"), "export const c = 1;\n");
	assert.equal(existsSync(join(cwd, "bash.txt")), false);
	assert.equal(existsSync(join(cwd, "new")), false, "folders left empty are removed");
	assert.equal(read(cwd, "secret.env"), "TOKEN=2\n", "gitignored files are left alone");
	assert.equal(existsSync(join(cwd, "build", "out.js")), true);
	assert.equal(statSync(join(cwd, "big.bin")).size, MAX_FILE_BYTES + 1, "large untracked files are left alone");

	// And forward again (what /redo does).
	const forward = await repo.restore(t2, files);
	assert.equal(forward.failed.length, 0);
	assert.equal(read(cwd, "a.txt"), "a2\n");
	assert.equal(read(cwd, "bash.txt"), "made by bash\n");
	assert.equal(existsSync(join(cwd, "b.txt")), false);

	assert.deepEqual(repoState(cwd), before, "the user's index, refs, HEAD, stash, config and objects (and their times) are unchanged");
	assert.equal(gitIn(cwd, "status", "--porcelain").includes("a.txt"), true, "and git sees the working tree as it is");
});

test("shadow repo: byte-exact restores, file modes and symlinks, no user git config or attributes", async () => {
	const { agentDir, cwd } = tempDirs();
	userRepo(cwd);
	// A user setup that would rewrite files if it applied: eol conversion and a filter.
	write(cwd, ".gitattributes", "* text=auto eol=crlf\n*.txt filter=upper\n");
	gitIn(cwd, "config", "filter.upper.clean", "tr a-z A-Z");
	write(cwd, "mixed.txt", "one\r\ntwo\nthree\r\n");
	write(cwd, "run.sh", "#!/bin/sh\necho hi\n");
	chmodSync(join(cwd, "run.sh"), 0o755);
	symlinkSync("a.txt", join(cwd, "link"));
	const repo = await open(cwd, agentDir);
	const t1 = (await repo.capture())!.tree;
	rmSync(join(cwd, "mixed.txt"));
	rmSync(join(cwd, "run.sh"));
	rmSync(join(cwd, "link"));
	const t2 = (await repo.capture())!.tree;
	const files = (await repo.changedFiles(t1, t2))!;
	await repo.restore(t1, files);
	assert.equal(read(cwd, "mixed.txt"), "one\r\ntwo\nthree\r\n");
	assert.equal(statSync(join(cwd, "run.sh")).mode & 0o111, 0o111, "executable bit kept");
	assert.ok(lstatSync(join(cwd, "link")).isSymbolicLink());
	assert.equal(readlinkSync(join(cwd, "link")), "a.txt");
});

test("shadow repo in a folder that is not a git repository", async () => {
	const { agentDir, cwd } = tempDirs();
	write(cwd, "notes.md", "v1\n");
	write(cwd, ".gitignore", "*.log\n");
	write(cwd, "node_modules/pkg/index.js", "dep");
	const repo = await open(cwd, agentDir);
	assert.equal(repo.isGitRepo, false);
	assert.equal(existsSync(join(repo.gitDir, "objects", "info", "alternates")), false);
	const t1 = (await repo.capture())!.tree;
	write(cwd, "notes.md", "v2\n");
	write(cwd, "app.log", "log");
	write(cwd, "node_modules/pkg/index.js", "dep2");
	write(cwd, "made.txt", "x");
	const t2 = (await repo.capture())!.tree;
	const files = (await repo.changedFiles(t1, t2))!.sort();
	assert.deepEqual(files, ["made.txt", "notes.md"], ".gitignore and dependency folders are skipped");
	await repo.restore(t1, files);
	assert.equal(read(cwd, "notes.md"), "v1\n");
	assert.equal(existsSync(join(cwd, "made.txt")), false);
	assert.equal(read(cwd, "node_modules/pkg/index.js"), "dep2");
	assert.equal(existsSync(join(cwd, ".git")), false, "no .git is created in the folder");
});

test("a file too large to snapshot is left out of snapshots; large tracked files are kept", async () => {
	const plain = tempDirs();
	write(plain.cwd, "data.csv", "row\n".repeat(MAX_FILE_BYTES / 2));
	write(plain.cwd, "notes.md", "v1\n");
	const repo = await open(plain.cwd, plain.agentDir);
	const before = (await repo.capture())!;
	assert.deepEqual(before.skipped, ["data.csv"]);
	write(plain.cwd, "data.csv", "row\nrow\n");
	write(plain.cwd, "notes.md", "v2\n");
	const after = (await repo.capture())!;
	assert.deepEqual(after.skipped, [], "small again, so in this snapshot");

	// A git repository: large files git tracks are snapshotted (and restored) like any other.
	const tracked = tempDirs();
	userRepo(tracked.cwd);
	write(tracked.cwd, "big.log", "x".repeat(MAX_FILE_BYTES + 10));
	gitIn(tracked.cwd, "add", "big.log");
	gitIn(tracked.cwd, "commit", "-qm", "big");
	const repo2 = await open(tracked.cwd, tracked.agentDir);
	const t1 = (await repo2.capture())!;
	assert.deepEqual(t1.skipped, []);
	write(tracked.cwd, "big.log", "small\n");
	const t2 = (await repo2.capture())!;
	const files = (await repo2.changedFiles(t1.tree, t2.tree))!;
	assert.deepEqual(files, ["big.log"]);
	assert.deepEqual(await repo2.restore(t1.tree, files), { restored: ["big.log"], removed: [], failed: [] });
	assert.equal(statSync(join(tracked.cwd, "big.log")).size, MAX_FILE_BYTES + 10);
	assert.equal(gitIn(tracked.cwd, "status", "--porcelain"), "");
});

test("a snapshot keeps its own copy of what only the user's repository stores, and survives git gc", async () => {
	const { agentDir, cwd } = tempDirs();
	userRepo(cwd);
	write(cwd, "a.txt", "staged only\n");
	gitIn(cwd, "add", "a.txt"); // the blob is in the user's objects, reachable from nothing but the index
	const repo = await open(cwd, agentDir);
	const before = repoState(cwd);
	const t1 = (await repo.capture())!.tree;
	assert.deepEqual(repoState(cwd), before, "copying reads the user's store, never writes it");
	write(cwd, "a.txt", "model's version\n");
	const t2 = (await repo.capture())!.tree;
	// The user throws the staged change away and prunes.
	gitIn(cwd, "reset", "-q", "--hard");
	gitIn(cwd, "reflog", "expire", "--expire=now", "--all");
	gitIn(cwd, "gc", "-q", "--prune=now");
	write(cwd, "a.txt", "model's version\n");
	assert.deepEqual(await repo.restore(t1, ["a.txt"]), { restored: ["a.txt"], removed: [], failed: [] });
	assert.equal(read(cwd, "a.txt"), "staged only\n");
	await repo.restore(t2, ["a.txt"]);
	assert.equal(read(cwd, "a.txt"), "model's version\n");
});

test("an undo survives the user's commit being amended and pruned", async () => {
	const { agentDir, cwd } = tempDirs();
	userRepo(cwd);
	mkdirSync(join(cwd, "docs"));
	write(cwd, "docs/d.txt", "d1\n");
	gitIn(cwd, "add", ".");
	gitIn(cwd, "commit", "-qm", "second");
	const repo = await open(cwd, agentDir);
	const t1 = (await repo.capture())!.tree; // a.txt and docs/ as HEAD has them: not copied here
	write(cwd, "a.txt", "by the model\n");
	const t2 = (await repo.capture())!.tree;
	assert.deepEqual(await repo.changedFiles(t1, t2), ["a.txt"]);
	// The user rewrites the commit (a.txt and docs/ change) and prunes everything unreachable.
	write(cwd, "a.txt", "amended\n");
	write(cwd, "docs/d.txt", "d2\n");
	gitIn(cwd, "commit", "-qa", "--amend", "-m", "second, amended");
	gitIn(cwd, "reflog", "expire", "--expire=now", "--all");
	gitIn(cwd, "gc", "-q", "--prune=now");
	write(cwd, "a.txt", "by the model\n");
	assert.deepEqual(await repo.restore(t1, ["a.txt"]), { restored: ["a.txt"], removed: [], failed: [] });
	assert.equal(read(cwd, "a.txt"), "a1\n");
});

test("restores keep a file's permissions; differing() lists only what a restore would change", async () => {
	const { agentDir, cwd } = tempDirs();
	write(cwd, "run.sh", "#!/bin/sh\n");
	write(cwd, "private.txt", "p1\n");
	write(cwd, "same.txt", "s\n");
	chmodSync(join(cwd, "run.sh"), 0o750);
	chmodSync(join(cwd, "private.txt"), 0o600);
	const repo = await open(cwd, agentDir);
	const t1 = (await repo.capture())!.tree;
	chmodSync(join(cwd, "run.sh"), 0o640);
	write(cwd, "private.txt", "p2\n");
	write(cwd, "made.txt", "m\n");
	const t2 = (await repo.capture())!.tree;
	const files = (await repo.changedFiles(t1, t2))!;
	assert.deepEqual(files.sort(), ["made.txt", "private.txt", "run.sh"]);
	assert.deepEqual((await repo.differing(t1, [...files, "same.txt"])).sort(), ["made.txt", "private.txt", "run.sh"]);
	assert.deepEqual(await repo.differing(t2, [...files, "same.txt"]), [], "already at t2");
	await repo.restore(t1, files);
	assert.equal(statSync(join(cwd, "run.sh")).mode & 0o777, 0o750, "executable again, nothing else added");
	assert.equal(statSync(join(cwd, "private.txt")).mode & 0o777, 0o600, "still private");
	assert.equal(read(cwd, "private.txt"), "p1\n");
	assert.deepEqual(await repo.differing(t1, files), []);
});

test("snapshots record exact permission bits, which restores put back (also when only they changed)", async () => {
	const { agentDir, cwd } = tempDirs();
	write(cwd, "tool.sh", "#!/bin/sh\n");
	write(cwd, "notes.txt", "n\n");
	write(cwd, "key.pem", "k1\n");
	chmodSync(join(cwd, "tool.sh"), 0o640);
	chmodSync(join(cwd, "notes.txt"), 0o644);
	chmodSync(join(cwd, "key.pem"), 0o644);
	const repo = await open(cwd, agentDir);
	const s1 = (await repo.capture())!;
	assert.equal(s1.perms.get("tool.sh"), 0o640);
	chmodSync(join(cwd, "tool.sh"), 0o711); // executable, and the group's read bit gone
	chmodSync(join(cwd, "notes.txt"), 0o600); // git does not see this one
	write(cwd, "key.pem", "k2\n");
	chmodSync(join(cwd, "key.pem"), 0o600);
	const s2 = (await repo.capture())!;
	assert.deepEqual(await repo.changedFiles(s1.tree, s2.tree), ["key.pem", "tool.sh"], "git sees content and the executable bit");
	const files = ["key.pem", "notes.txt", "tool.sh"];
	const perms = (s: typeof s1) => Object.fromEntries(s.perms);
	assert.deepEqual((await repo.differing(s1.tree, files, { perms: perms(s1) })).sort(), files, "a permission change counts");

	const back = await repo.restore(s1.tree, files, { perms: perms(s1) });
	assert.deepEqual(back.restored.sort(), files);
	const mode = (path: string) => statSync(join(cwd, path)).mode & 0o7777;
	assert.deepEqual([mode("tool.sh"), mode("notes.txt"), mode("key.pem")], [0o640, 0o644, 0o644]);
	assert.equal(read(cwd, "key.pem"), "k1\n");
	const forward = await repo.restore(s2.tree, files, { perms: perms(s2) });
	assert.deepEqual(forward.failed, []);
	assert.deepEqual([mode("tool.sh"), mode("notes.txt"), mode("key.pem")], [0o711, 0o600, 0o600], "exactly as after the change");
	assert.deepEqual(await repo.differing(s2.tree, files, { perms: perms(s2) }), []);
});

test("a restore removes the folders it empties only if they did not exist when the snapshot was taken", async () => {
	const { agentDir, cwd } = tempDirs();
	userRepo(cwd);
	mkdirSync(join(cwd, "empty"));
	mkdirSync(join(cwd, "logs", "old"), { recursive: true });
	write(cwd, "gone/only.txt", "o\n");
	const repo = await open(cwd, agentDir);
	const s1 = (await repo.capture())!;
	write(cwd, "empty/made.txt", "m\n"); // into a folder that existed, empty
	write(cwd, "logs/old/x.txt", "x\n");
	write(cwd, "fresh/deep/n.txt", "n\n"); // new folders
	rmSync(join(cwd, "gone", "only.txt")); // leaves gone/ empty
	const s2 = (await repo.capture())!;
	const files = (await repo.changedFiles(s1.tree, s2.tree))!;
	await repo.restore(s1.tree, files, { at: s1.at });
	assert.equal(existsSync(join(cwd, "empty")), true, "an empty folder that existed stays");
	assert.equal(existsSync(join(cwd, "logs", "old")), true);
	assert.equal(existsSync(join(cwd, "fresh")), false, "new folders go");
	assert.equal(read(cwd, "gone/only.txt"), "o\n");
	// Forward again: gone/ existed, empty, after the change, so it stays.
	await repo.restore(s2.tree, files, { at: s2.at });
	assert.equal(existsSync(join(cwd, "gone")), true);
	assert.equal(existsSync(join(cwd, "fresh", "deep", "n.txt")), true);
	assert.equal(existsSync(join(cwd, "empty", "made.txt")), true);
});

test("restores leave alone files that already match, and files whose content is missing", async () => {
	const { agentDir, cwd } = tempDirs();
	write(cwd, "same.txt", "same\n");
	write(cwd, "lost.txt", "v1 of lost\n");
	const repo = await open(cwd, agentDir);
	const t1 = (await repo.capture())!.tree;
	write(cwd, "lost.txt", "v2\n");
	write(cwd, "made.txt", "m\n");
	const t2 = (await repo.capture())!.tree;
	rmSync(join(cwd, "made.txt")); // already gone
	// The saved blob of lost.txt disappears from the shadow store.
	const oid = execFileSync("git", ["hash-object", "--stdin"], { input: "v1 of lost\n", encoding: "utf8" }).trim();
	rmSync(join(repo.gitDir, "objects", oid.slice(0, 2), oid.slice(2)));
	const result = await repo.restore(t1, ["same.txt", "lost.txt", "made.txt"]);
	assert.deepEqual(result, { restored: [], removed: [], failed: ["lost.txt"] });
	assert.equal(read(cwd, "lost.txt"), "v2\n", "not touched");
	assert.ok(t2);
});

test("files git tracks although a .gitignore matches them are snapshotted", async () => {
	const { agentDir, cwd } = tempDirs();
	userRepo(cwd);
	write(cwd, "build/forced.js", "v1\n"); // build/ is ignored
	gitIn(cwd, "add", "-f", "build/forced.js");
	gitIn(cwd, "commit", "-qm", "forced");
	write(cwd, "build/other.js", "ignored\n");
	const repo = await open(cwd, agentDir);
	const t1 = (await repo.capture())!.tree;
	write(cwd, "build/forced.js", "v2\n");
	write(cwd, "build/other.js", "still ignored\n");
	const t2 = (await repo.capture())!.tree;
	const files = (await repo.changedFiles(t1, t2))!;
	assert.deepEqual(files, ["build/forced.js"]);
	await repo.restore(t1, files);
	assert.equal(read(cwd, "build/forced.js"), "v1\n");
	assert.equal(read(cwd, "build/other.js"), "still ignored\n");
});
test("without git, checkpoints say so instead of failing", () => {
	const script = `const { ShadowRepo } = await import(${JSON.stringify(new URL("../src/checkpoints.ts", import.meta.url).href)});
		const repo = await ShadowRepo.open(process.cwd(), ${JSON.stringify(tempDirs().agentDir)});
		process.stdout.write(JSON.stringify(repo));`;
	const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: "" }, encoding: "utf8" });
	assert.deepEqual(JSON.parse(out), { unavailable: "git is not installed" });
});


test("restore summary", () => {
	assert.equal(describeRestore({ restored: ["a.ts"], removed: [], failed: [] }), "restored 1 file (a.ts)");
	assert.equal(describeRestore({ restored: ["a", "b"], removed: ["c", "d"], failed: [] }), "restored 2 files and removed 2 (a, b, c and 1 more)");
	assert.equal(describeRestore({ restored: [], removed: ["n.ts"], failed: [] }), "removed 1 file (n.ts)");
	assert.match(describeRestore({ restored: ["a"], removed: [], failed: ["x"] }), /could not restore x/);
});

// --- The feature, through wisp's Agent with real tools and an in-memory session. ---

type Step = CompletionResult["content"];

class ScriptedProvider implements Provider {
	name = "anthropic";
	model = "claude-opus-5-5";
	seen: Message[][] = [];
	constructor(public script: Step[] = []) {}
	async complete(req: CompletionRequest): Promise<CompletionResult> {
		this.seen.push(structuredClone(req.messages));
		const content = this.script.shift() ?? [{ type: "text" as const, text: "done" }];
		return { content, stopReason: content.some((b) => b.type === "tool_call") ? "tool_use" : "end", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
	}
}

let callId = 0;
const call = (name: string, input: Record<string, unknown>) => ({ type: "tool_call" as const, id: `c${++callId}`, name, input });

function harness(cwd: string, home: string, o: { session?: Session; enabled?: boolean } = {}) {
	const provider = new ScriptedProvider();
	const agent = new Agent({ cwd, provider, model: modelInfo("anthropic", "claude-opus-5-5"), tools: ALL_TOOLS, system: "sys", thinking: "off" });
	const session = o.session ?? Session.create(cwd, { persist: false });
	agent.subscribe((e) => logAgentEvent(session, agent, e));
	const notices: string[] = [];
	const answers: unknown[] = [];
	const asked: string[] = [];
	const ui: FeatureUI = {
		interactive: true,
		notice: (t) => void notices.push(t),
		flash: () => {},
		render: () => {},
		height: 40,
		select: (async (q: { title: string }) => {
			asked.push(q.title);
			return answers.shift();
		}) as FeatureUI["select"],
		input: async () => undefined,
	};
	const settings = new SettingsStore(cwd, { global: join(home, "settings.json"), project: join(cwd, ".wisp", "settings.json") });
	const feature = checkpointsFeature({ home });
	installFeatures({ cwd, agent, settings, ui, session: () => session, refreshTools: () => agent.refreshTools() }, [feature]);
	if (o.enabled === false) settings.set("checkpoints", false);
	const cmd = async (name: string) => {
		const before = notices.length;
		await feature.commands!.find((c) => c.name === name)!.run("");
		return notices.slice(before).join("\n");
	};
	const prompt = async (text: string, ...steps: Step[]) => {
		provider.script.push(...steps, [{ type: "text", text: "ok" }]);
		await agent.run([{ type: "text", text }], new AbortController().signal);
		await feature.idle();
	};
	/** What /tree does: move the head, reload, tell the features. */
	const jump = async (id: string | null) => {
		const from = session.head;
		session.moveHead(id);
		agent.load(restore(session.entries).messages);
		feature.branchChanged!({ session, from });
		await feature.idle();
	};
	const kinds: Record<string, string> = { start: START_ENTRY, done: CHECKPOINT_ENTRY };
	const records = (kind?: string) =>
		session.entries.flatMap((e) => (e.type === "custom" && e.customType.startsWith("wisp-checkpoint") && (!kind || e.customType === kinds[kind]) ? [e.data] : []));
	return { agent, provider, session, feature, notices, answers, asked, settings, cmd, prompt, jump, records };
}

test("/undo and /redo: write_file and bash changes, stacks across prompts, the model is told, new changes end redo", async () => {
	const { cwd, agentDir } = tempDirs();
	userRepo(cwd);
	const before = repoState(cwd);
	const h = harness(cwd, agentDir);

	// A prompt that only reads makes no checkpoint.
	await h.prompt("look", [call("read_file", { path: "a.txt" })]);
	assert.equal(h.records().length, 0);

	await h.prompt("one", [call("write_file", { path: "new.txt", content: "n\n" }), call("bash", { command: "printf 'a2\\n' > a.txt && rm b.txt" })]);
	assert.equal(h.records("start").length, 1, "the before-snapshot is saved before the first change");
	const [done] = h.records("done") as unknown as { files: string[] }[];
	assert.deepEqual(done!.files.sort(), ["a.txt", "b.txt", "new.txt"]);

	await h.prompt("two", [call("read_file", { path: "a.txt" })], [call("edit_file", { path: "a.txt", old_string: "a2", new_string: "a3" })]);
	assert.equal(read(cwd, "a.txt"), "a3\n");

	assert.equal(await h.cmd("undo"), "Undo: restored 1 file (a.txt). /redo brings the changes back.");
	assert.equal(read(cwd, "a.txt"), "a2\n");
	assert.match(await h.cmd("undo"), /^Undo: restored 2 files and removed 1 \(/);
	assert.equal(read(cwd, "a.txt"), "a1\n");
	assert.equal(read(cwd, "b.txt"), "b1\n");
	assert.equal(existsSync(join(cwd, "new.txt")), false);
	assert.equal(await h.cmd("undo"), "Nothing left to undo (/redo brings changes back).");

	assert.match(await h.cmd("redo"), /^Redo: restored 2 files and removed 1/);
	assert.equal(read(cwd, "new.txt"), "n\n");
	assert.equal(existsSync(join(cwd, "b.txt")), false);

	// The next prompt starts with a note for the model.
	await h.prompt("three", [call("write_file", { path: "c.txt", content: "c\n" })]);
	const sent = h.provider.seen.at(-2)!;
	const texts = sent.flatMap((m) => (m.role === "user" ? m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])) : []));
	assert.ok(texts.some((t) => t.includes("/redo") && t.includes("new.txt")), "the model hears about the redo");
	assert.equal(await h.cmd("redo"), "Nothing to redo.", "new changes end what /redo could bring back");
	assert.equal(await h.cmd("undo"), "Undo: removed 1 file (c.txt). /redo brings the changes back.");
	assert.deepEqual(repoState(cwd), before, "the user's .git is never written");
});

test("/tree back to before the changes offers to restore files; going forward again restores them", async () => {
	const { cwd, agentDir } = tempDirs();
	write(cwd, "f.txt", "v0\n");
	const h = harness(cwd, agentDir);
	await h.prompt("one", [call("read_file", { path: "f.txt" })], [call("write_file", { path: "f.txt", content: "v1\n" })]);
	const afterOne = h.session.head;
	await h.prompt("two", [call("read_file", { path: "f.txt" })], [call("write_file", { path: "f.txt", content: "v2\n" }), call("write_file", { path: "g.txt", content: "g\n" })]);
	const afterTwo = h.session.head;

	// Back to the end of the first prompt, answering no: nothing changes.
	h.answers.push(false);
	await h.jump(afterOne);
	assert.deepEqual(h.asked, ["Restore files to that point too?"]);
	assert.equal(read(cwd, "f.txt"), "v2\n");
	// Forward and back again, this time yes (forward first: nothing to restore, no question).
	await h.jump(afterTwo);
	assert.equal(h.asked.length, 1);
	h.answers.push(true);
	await h.jump(afterOne);
	assert.equal(read(cwd, "f.txt"), "v1\n");
	assert.equal(existsSync(join(cwd, "g.txt")), false);
	assert.match(h.notices.at(-1)!, /^Files back to that point: restored 1 file and removed 1/);

	// A new branch from here: undo history follows it.
	await h.prompt("three", [call("write_file", { path: "h.txt", content: "h\n" })]);
	assert.equal(await h.cmd("undo"), "Undo: removed 1 file (h.txt). /redo brings the changes back.");
	assert.equal(await h.cmd("undo"), "Undo: restored 1 file (f.txt). /redo brings the changes back.");
	assert.equal(read(cwd, "f.txt"), "v0\n");
	const history = checkpointHistory(checkpointLog(h.session), cwd, afterTwo!);
	assert.equal(history.done.length, 2, "the other branch still has both of its checkpoints");

	// Back to the other branch's end, yes: its files come back.
	h.answers.push(true);
	await h.jump(afterTwo);
	assert.equal(read(cwd, "f.txt"), "v2\n");
	assert.equal(read(cwd, "g.txt"), "g\n");
	assert.equal(existsSync(join(cwd, "h.txt")), false);
});

test("a prompt cut short (wisp killed) is recorded at the next load from its saved start snapshot", async () => {
	const { cwd, agentDir } = tempDirs();
	write(cwd, "f.txt", "v0\n");
	const path = join(agentDir, "s.jsonl");
	const a = harness(cwd, agentDir);
	await a.prompt("one", [call("read_file", { path: "f.txt" })], [call("write_file", { path: "f.txt", content: "v1\n" })]);
	// Simulate a crash: keep only what was logged up to the start record, then the change happens.
	const entries = a.session.entries;
	const startAt = entries.findIndex((e) => e.type === "custom" && e.customType === START_ENTRY);
	writeFileSync(path, entries.slice(0, startAt + 1).map((e) => JSON.stringify(e)).join("\n") + "\n");
	const { session } = Session.open(path);
	const b = harness(cwd, agentDir, { session });
	b.feature.sessionLoaded!({ session, reason: "resume" });
	await b.feature.idle();
	assert.equal(b.records("done").length, 1);
	assert.equal(await b.cmd("undo"), "Undo: restored 1 file (f.txt). /redo brings the changes back.");
	assert.equal(read(cwd, "f.txt"), "v0\n");
});

test("turned off: no snapshots and the commands say so", async () => {
	const { cwd, agentDir } = tempDirs();
	const h = harness(cwd, agentDir, { enabled: false });
	await h.prompt("one", [call("write_file", { path: "f.txt", content: "v1\n" })]);
	assert.equal(h.records().length, 0);
	assert.equal(existsSync(join(agentDir, "checkpoints")), false);
	assert.match(await h.cmd("undo"), /unavailable while Checkpoints are off/);
	h.settings.set("checkpoints", true);
	await h.prompt("two", [call("write_file", { path: "f.txt", content: "v2\n" })]);
	assert.equal(await h.cmd("undo"), "Undo: restored 1 file (f.txt). /redo brings the changes back.");
	assert.equal(read(cwd, "f.txt"), "v1\n");
});
