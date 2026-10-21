import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readHistory, stageTimeline, hotspots, changeCoupling } from "../src/history.ts";
import { setBaseline, readBaseline, diffSinceBaseline, changesByDir } from "../src/baseline.ts";
import { writeSnapshot } from "../src/snapshot.ts";
import { readCounts } from "../src/store.ts";

let repo = "";
let state = "";
const git = (...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-C", repo, ...args], { encoding: "utf8" });
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text, "utf8");
};

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "glassbox-hist-"));
  state = fs.mkdtempSync(path.join(os.tmpdir(), "glassbox-state-"));
  git("init", "-q", "-b", "main");
  write("app/a.py", "import os\n");
  write("app/b.py", "x = 1\n");
  git("add", "-A");
  git("commit", "-q", "-m", "feat(v0.1 S1): 起步");
  write("app/a.py", "import os\nimport sys\n");
  write("docs/notes.md", "# 笔记\n");
  git("add", "-A");
  git("commit", "-q", "-m", "docs(v0.1 S2): 补笔记");
  write("app/a.py", "import os\nimport sys\nimport json\n");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: 无标签提交");
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(state, { recursive: true, force: true });
});

test("git 历史：提交、文件增删、阶段标签、热点、耦合", async () => {
  const commits = await readHistory(repo, { stageTag: String.raw`v\d+(?:\.\d+)*\s+S\d+` });
  assert.equal(commits.length, 3);
  assert.deepEqual(commits.map((c) => c.stage), [undefined, "v0.1 S2", "v0.1 S1"]);
  const first = commits[2];
  assert.deepEqual(first?.files.map((f) => f.path).sort(), ["app/a.py", "app/b.py"]);
  const timeline = stageTimeline(commits);
  assert.deepEqual(timeline.map((s) => s.stage), ["v0.1 S1", "v0.1 S2"]);
  const hot = hotspots(commits, 5);
  assert.equal(hot[0]?.path, "app/a.py");
  assert.equal(hot[0]?.commits, 3);
  const coupling = changeCoupling(commits);
  assert.ok(coupling.some((c) => c.a === "app/a.py" && c.b === "app/b.py" && c.together === 1));
});

test("基线：记录、读回、差异含已提交、未提交与未跟踪", async () => {
  const firstSha = git("rev-list", "--max-parents=0", "HEAD").trim();
  const b = await setBaseline(repo, state, "test", firstSha);
  assert.equal(readBaseline(state)?.commit, firstSha);
  write("app/b.py", "x = 2\n");
  write("app/new.py", "y = 1\n");
  const diff = await diffSinceBaseline(repo, b);
  assert.equal(diff.commitsSince, 2);
  const byPath = Object.fromEntries(diff.changes.map((c) => [c.path, c]));
  assert.equal(byPath["app/a.py"]?.status, "M");
  assert.equal(byPath["app/a.py"]?.committed, true);
  assert.equal(byPath["docs/notes.md"]?.status, "A");
  assert.equal(byPath["app/b.py"]?.committed, false);
  assert.equal(byPath["app/new.py"]?.status, "?");
  const dirs = changesByDir(diff.changes);
  assert.equal(dirs[0]?.dir, "app");
  assert.equal(dirs[0]?.files, 3);
  assert.equal(dirs[0]?.uncommitted, 2);
});

test("快照：写出 JSON 与 sqlite，计数一致", async () => {
  const { snapshot, jsonPath, dbPath } = await writeSnapshot(repo, { stateDir: state });
  assert.ok(fs.existsSync(jsonPath));
  const counts = readCounts(dbPath);
  assert.equal(counts["files"], snapshot.files.length);
  assert.equal(counts["commits"], 3);
  assert.equal(counts["baseline"], 1);
  assert.equal(counts["changes"], snapshot.baseline?.changes.length);
  assert.equal(snapshot.history.latestStage, "v0.1 S2");
  assert.equal(snapshot.tiers["files"], "T0");
});
