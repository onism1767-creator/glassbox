import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Indexer } from "../src/indexer.ts";
import { hookToEvents, ActivityLog } from "../src/activity.ts";
import { Runtime } from "../src/runtime.ts";

const fixtures = path.join(import.meta.dirname, "fixtures");
let repo = "";
let state = "";

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "glassbox-inc-"));
  state = fs.mkdtempSync(path.join(os.tmpdir(), "glassbox-inc-state-"));
  fs.cpSync(path.join(fixtures, "mini-py"), repo, { recursive: true });
});
after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(state, { recursive: true, force: true });
});

test("增量：改一个文件只重解析一个，新违规立刻出现；删文件后符号消失", async () => {
  const indexer = new Indexer(repo, { overlayFile: path.join(fixtures, "mini-py-overlay.yaml"), precise: false });
  const first = await indexer.run();
  assert.equal(first.changedFiles.length, first.files.length);
  assert.equal(first.violations.filter((v) => v.rule === "layer-direction").length, 1);

  const service = path.join(repo, "app", "service.py");
  fs.writeFileSync(service, "from web.views import render\n" + fs.readFileSync(service, "utf8"), "utf8");
  const second = await indexer.run();
  assert.deepEqual(second.changedFiles, ["app/service.py"]);
  const direction = second.violations.filter((v) => v.rule === "layer-direction").map((v) => `${v.evidence.path}:${v.evidence.line}`).sort();
  assert.deepEqual(direction, ["app/service.py:1", "core/io.py:1"]);
  assert.ok(second.elapsedMs < 2000, `增量一轮 ${second.elapsedMs} ms`);

  fs.appendFileSync(service, "\n\ndef brand_new():\n    return run()\n", "utf8");
  const third = await indexer.run();
  assert.ok(third.symbols.some((s) => s.id === "app/service.py::brand_new"));
  assert.ok(third.calls.edges.some((e) => e.from === "app/service.py::brand_new" && e.to === "app/service.py::run"));

  fs.rmSync(path.join(repo, "util", "text.py"));
  const fourth = await indexer.run();
  assert.deepEqual(fourth.changedFiles, ["util/text.py"]);
  assert.ok(!fourth.symbols.some((s) => s.path === "util/text.py"));
  assert.equal(fourth.violations.filter((v) => v.rule === "isolated-package").length, 0);
  await indexer.close();
});

test("hook 翻译：编辑事件变触碰，仓库外忽略，会话开始要记基线", () => {
  const edit = hookToEvents(repo, { hook_event_name: "PostToolUse", session_id: "abcdef1234", tool_name: "Edit", cwd: repo, tool_input: { file_path: path.join(repo, "app", "service.py") } });
  assert.deepEqual(edit.touched, ["app/service.py"]);
  assert.equal(edit.events[0]?.session, "abcdef12");
  const outside = hookToEvents(repo, { hook_event_name: "PostToolUse", tool_name: "Write", cwd: repo, tool_input: { file_path: "C:/elsewhere/x.py" } });
  assert.equal(outside.touched.length, 0);
  assert.ok(outside.ignored);
  const start = hookToEvents(repo, { hook_event_name: "SessionStart", session_id: "s1", cwd: repo, source: "startup" });
  assert.equal(start.sessionStart?.session, "s1");
  const resume = hookToEvents(repo, { hook_event_name: "SessionStart", session_id: "s1", cwd: repo, source: "resume" });
  assert.equal(resume.sessionStart, undefined);
  const bash = hookToEvents(repo, { hook_event_name: "PostToolUse", tool_name: "Bash", cwd: repo, tool_input: { command: "pytest -q" } });
  assert.match(bash.events[0]?.text ?? "", /pytest/);
});

test("活动日志：追加、读回、最近触碰", () => {
  const log = new ActivityLog(state);
  log.record({ at: new Date().toISOString(), source: "hook", kind: "PostToolUse", session: "s1", tool: "Edit", path: "app/service.py", text: "Edit app/service.py" });
  log.record({ at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(), source: "hook", kind: "PostToolUse", session: "s1", tool: "Edit", path: "web/views.py", text: "old" });
  const reloaded = new ActivityLog(state);
  assert.equal(reloaded.recent().length, 2);
  assert.deepEqual(Object.keys(reloaded.touched()), ["app/service.py"]);
});

test("运行时事件归类：git 元数据、源码、测试结果、忽略；测试结果变了不算文件改动", async () => {
  const rt = new Runtime(repo, { stateDir: state, overlayFile: path.join(fixtures, "mini-py-overlay.yaml"), precise: false, log: () => undefined });
  assert.equal(rt.classify(".git/HEAD"), "git");
  assert.equal(rt.classify(".git/refs/heads/main"), "git");
  assert.equal(rt.classify(".git/objects/ab/cdef"), "ignore");
  assert.equal(rt.classify(".git/index"), "ignore");
  assert.equal(rt.classify("app/service.py"), "file");
  assert.equal(rt.classify(".workbench/snapshot.json"), "ignore");
  assert.equal(rt.classify("node_modules/x/index.js"), "ignore");
  assert.equal(rt.classify(".workbench/tasks/a.md"), "file");
  // 测试结果目录：只认顶层写好的 .xml / .json；自动跑过程中的 partial/ 和 .tmp 不算
  assert.equal(rt.classify(".workbench/test-results/junit.xml"), "tests");
  assert.equal(rt.classify(".workbench/test-results/coverage.json"), "tests");
  assert.equal(rt.classify(".workbench/test-results/results.json"), "tests");
  assert.equal(rt.classify(".workbench/test-results/results.json.tmp"), "ignore");
  assert.equal(rt.classify(".workbench/test-results/partial/junit.xml"), "ignore");
  assert.equal(rt.classify(".workbench/test-results/coveragerc"), "ignore");
  rt.onFsEvent(".workbench/test-results/results.json");
  rt.onFsEvent(".workbench/test-results/partial/junit.xml");
  rt.onFsEvent(".workbench/test-results/results.json.tmp");
  assert.deepEqual(rt.queued(), { files: [], git: false, tests: true });
  rt.onFsEvent("app/service.py");
  assert.deepEqual(rt.queued(), { files: ["app/service.py"], git: false, tests: true });
  await rt.stop();
});
