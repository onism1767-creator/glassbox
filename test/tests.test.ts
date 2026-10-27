import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJunit, parseCoverage, linkTests, classnameToFile, contextResolver, compactCoverage } from "../src/tests.ts";
import { parseEmojiList } from "../src/tasks.ts";
import { computeAllProgress, findInconsistencies, computeGauge } from "../src/progress.ts";
import type { FileEdge } from "../src/types.ts";

const junit = `<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" errors="0" failures="1" skipped="1" tests="4" time="0.5" timestamp="2026-10-27T09:12:00.123456" hostname="x">
<testcase classname="tests.unit.test_a" name="test_ok" time="0.010" />
<testcase classname="tests.unit.test_a" name="test_bad" time="0.020"><failure message="assert 1 == 2 &lt;x&gt;">traceback…</failure></testcase>
<testcase classname="tests.unit.test_a.TestGroup" name="test_in_class" time="0.001" />
<testcase classname="tests.unit.test_b" name="test_skip" time="0"><skipped type="pytest.skip" message="no db" /></testcase>
</testsuite></testsuites>`;

const known = new Set(["tests/unit/test_a.py", "tests/unit/test_b.py", "app/service.py", "app/models.py", "web/views.py"]);

test("junit：用例、状态、失败信息、classname 映射到文件，含类名", () => {
  const run = parseJunit(junit, known, "junit.xml", "2026-01-01T00:00:00Z");
  assert.equal(run.at, "2026-10-27T09:12:00.123456");
  assert.deepEqual([run.total, run.passed, run.failed, run.errors, run.skipped], [4, 2, 1, 0, 1]);
  const bad = run.cases.find((c) => c.name === "test_bad");
  assert.equal(bad?.status, "failed");
  assert.equal(bad?.message, "assert 1 == 2 <x>");
  assert.equal(bad?.file, "tests/unit/test_a.py");
  assert.equal(run.cases.find((c) => c.name === "test_in_class")?.id, "tests/unit/test_a.py::TestGroup::test_in_class");
  assert.deepEqual(classnameToFile("tests.unit.test_a.TestGroup", known), { file: "tests/unit/test_a.py", rest: ["TestGroup"] });
});

const coverageJson = JSON.stringify({
  meta: { timestamp: "2026-10-27T09:12:01", show_contexts: true },
  files: {
    "app\\service.py": { summary: { covered_lines: 8, num_statements: 10, percent_covered: 80 }, contexts: { "1": ["tests/unit/test_a.py::test_ok|run", "tests/unit/test_a.py::test_bad|run"], "5": [""] } },
    "app/models.py": { summary: { covered_lines: 3, num_statements: 3, percent_covered: 100 }, contexts: { "1": ["tests/unit/test_a.py::test_ok|run"] } },
    "web/views.py": { summary: { covered_lines: 0, num_statements: 4, percent_covered: 0 }, contexts: {} },
  },
  totals: { percent_covered: 64.7 },
});

test("coverage：路径归一、百分比、上下文变成「谁跑过这个文件」", () => {
  const cov = parseCoverage(coverageJson, "C:/repo", "coverage.json", "x");
  assert.equal(cov.hasContexts, true);
  assert.equal(cov.totalPercent, 64.7);
  assert.equal(cov.files["app/service.py"]?.percent, 80);
  assert.deepEqual(cov.coveredBy["app/service.py"], ["tests/unit/test_a.py::test_bad", "tests/unit/test_a.py::test_ok"]);
  assert.equal(cov.coveredBy["web/views.py"], undefined);
});

test("链接：有上下文用上下文（T0），没有就按测试文件 import 推断（T1）", () => {
  const run = parseJunit(junit, known, "junit.xml", "x");
  const cov = parseCoverage(coverageJson, "C:/repo", "coverage.json", "x");
  const edges: FileEdge[] = [{ from: "tests/unit/test_b.py", to: "web/views.py", kind: "import", evidence: [{ path: "tests/unit/test_b.py", line: 1 }] }];
  const { fileStatus, testFiles } = linkTests(run, cov, edges, [...known]);
  assert.deepEqual(testFiles, ["tests/unit/test_a.py", "tests/unit/test_b.py"]);
  const svc = fileStatus["app/service.py"]!;
  assert.deepEqual([svc.passed, svc.failed, svc.tier, svc.coverage?.percent], [1, 1, "T0", 80]);
  const views = fileStatus["web/views.py"]!;
  assert.deepEqual([views.related, views.skipped, views.tier], [["tests/unit/test_b.py::test_skip"], 1, "T1"]);
  const testA = fileStatus["tests/unit/test_a.py"]!;
  assert.deepEqual([testA.passed, testA.failed], [2, 1]);
});

test("上下文：coverage 自己记的「模块名.函数名」和 pytest-cov 的 node id 都对回 junit 用例，参数化展开成多个", () => {
  const xml = `<testsuite><testcase classname="tests.unit.test_a" name="test_ok" time="0"/><testcase classname="tests.unit.test_a.TestGroup" name="test_in_class" time="0"/>
<testcase classname="tests.unit.test_p" name="test_many[1]" time="0"/><testcase classname="tests.unit.test_p" name="test_many[2]" time="0"/><testcase classname="tests.other.test_a" name="test_other" time="0"/></testsuite>`;
  const k = new Set([...known, "tests/unit/test_p.py", "tests/other/test_a.py"]);
  const run = parseJunit(xml, k, "junit.xml", "x");
  const files = [...new Set(run.cases.map((c) => c.file!))];
  const r = contextResolver(run.cases, files);
  assert.deepEqual(r("test_a.test_ok|run"), ["tests/unit/test_a.py::test_ok"]);
  assert.deepEqual(r("test_a.TestGroup.test_in_class"), ["tests/unit/test_a.py::TestGroup::test_in_class"]);
  assert.deepEqual(r("test_p.test_many"), ["tests/unit/test_p.py::test_many[1]", "tests/unit/test_p.py::test_many[2]"]);
  assert.deepEqual(r("test_a.test_other"), ["tests/other/test_a.py::test_other"]);
  assert.deepEqual(r("tests/unit/test_p.py::test_many[2]|run"), ["tests/unit/test_p.py::test_many[1]", "tests/unit/test_p.py::test_many[2]"]);
  assert.deepEqual(r("nowhere.test_x"), []);
  assert.deepEqual(r(""), []);
  const cov = parseCoverage(JSON.stringify({ meta: { show_contexts: true }, files: { "app/service.py": { summary: { covered_lines: 1, num_statements: 1, percent_covered: 100 }, contexts: { "1": ["test_a.test_ok", "test_p.test_many"] } } } }), "C:/repo", "c", "x");
  const { fileStatus } = linkTests(run, cov, [], ["app/service.py"]);
  assert.deepEqual([fileStatus["app/service.py"]!.related.length, fileStatus["app/service.py"]!.passed, fileStatus["app/service.py"]!.tier], [3, 3, "T0"]);
});

test("压缩：带上下文的大 coverage json 压成摘要加测试集合，解析结果一样", () => {
  const small = compactCoverage(coverageJson);
  assert.ok(small.length < coverageJson.length);
  const a = parseCoverage(coverageJson, "C:/repo", "c", "x");
  const b = parseCoverage(small, "C:/repo", "c", "x");
  assert.deepEqual(b.files, a.files);
  assert.deepEqual(b.coveredBy, a.coveredBy);
  assert.equal(b.hasContexts, true);
  assert.equal(b.totalPercent, 64.7);
  assert.equal(b.at, "2026-10-27T09:12:01");
});

test("任务：测试信号有值，「N 测试全绿」声明与实测对照，完成但相关测试红会被标出", () => {
  const text = "- ✅ **S1** 做服务(2026-10-12;3 测试全绿) `app/service.py`\n- ✅ **S2** 页面 `web/views.py`\n";
  const tasks = parseEmojiList("docs/任务列表.md", text);
  const run = parseJunit(junit, known, "junit.xml", "x");
  const cov = parseCoverage(coverageJson, "C:/repo", "coverage.json", "x");
  const edges: FileEdge[] = [];
  const { fileStatus, testFiles } = linkTests(run, cov, edges, [...known]);
  const tests = { run, coverage: { source: "c", at: "x", hasContexts: true, totalPercent: 64.7, files: cov.files }, fileStatus, testFiles, problems: [], howTo: "" };
  const commits = [{ sha: "c1", date: "2026-10-20T10:00:00+08:00", author: "a", subject: "feat(v0.1 S3): 后面", stage: "v0.1 S3", files: [] }, { sha: "c0", date: "2026-10-12T10:00:00+08:00", author: "a", subject: "feat(v0.1 S1): 做", stage: "v0.1 S1", files: [] }];
  const all = computeAllProgress(tasks, { commits, changes: [], touched: {}, tests, now: Date.parse("2026-10-27T00:00:00Z") });
  const s1 = all.get("S1")!;
  const testSignal = s1.signals.find((s) => s.name === "测试")!;
  assert.equal(testSignal.value, 0.5);
  assert.equal(testSignal.tier, "T0");
  assert.equal(s1.testsFailed, 1);
  const claim = s1.signals.find((s) => s.name === "验收声明")!;
  assert.match(claim.text, /与声明不符/);
  const inc = findInconsistencies(tasks, all, computeGauge(tasks, commits, all));
  assert.ok(inc.some((i) => i.taskId === "S1" && i.kind === "完成但相关测试红"));
  const s2 = all.get("S2")!;
  assert.match(s2.signals.find((s) => s.name === "测试")?.text ?? "", /对不上任何测试/);
});
