import { test } from "node:test";
import assert from "node:assert/strict";
import { selectTests, mergeRuns, baseId } from "../src/autotest.ts";
import { parseJunit, parseCoverage, linkTests, type TestSnapshot } from "../src/tests.ts";
import type { FileEdge } from "../src/types.ts";

const junit = `<testsuite timestamp="2026-10-27T10:00:00">
<testcase classname="tests.unit.test_a" name="test_ok" time="0.01"/>
<testcase classname="tests.unit.test_a" name="test_bad" time="0.02"><failure message="boom"/></testcase>
<testcase classname="tests.unit.test_p" name="test_many[1]" time="0"/>
<testcase classname="tests.unit.test_p" name="test_many[2]" time="0"/>
<testcase classname="tests.unit.test_b" name="test_skip" time="0"><skipped message="no db"/></testcase>
<testcase classname="integration.test_flow" name="test_end_to_end" time="1"/>
</testsuite>`;
const known = new Set(["tests/unit/test_a.py", "tests/unit/test_p.py", "tests/unit/test_b.py", "integration/test_flow.py", "integration/conftest.py", "app/service.py", "app/models.py", "web/views.py", "app/new.py"]);
const coverage = JSON.stringify({
  meta: { show_contexts: true },
  files: {
    "app/service.py": { summary: { covered_lines: 8, num_statements: 10, percent_covered: 80 }, contexts: { "1": ["test_a.test_ok", "test_a.test_bad", "test_p.test_many"] } },
    "app/models.py": { summary: { covered_lines: 3, num_statements: 3, percent_covered: 100 }, contexts: { "1": ["test_flow.test_end_to_end"] } },
  },
  totals: { percent_covered: 70 },
});

function snapshot(): TestSnapshot {
  const run = parseJunit(junit, known, "junit.xml", "x");
  const cov = parseCoverage(coverage, "C:/repo", "coverage.json", "x");
  const edges: FileEdge[] = [{ from: "tests/unit/test_b.py", to: "web/views.py", kind: "import", evidence: [{ path: "tests/unit/test_b.py", line: 1 }] }];
  const { fileStatus, testFiles } = linkTests(run, cov, edges, [...known]);
  return { run, fileStatus, testFiles, problems: [], howTo: "" };
}

test("选择：覆盖率上下文 T0、import 推断 T1、测试文件本身、conftest 整目录；不是 .py 或不知道相关测试的跳过", () => {
  const s = selectTests(["app/service.py", "web/views.py", "tests/unit/test_b.py", "integration/conftest.py", "docs/x.md", "app/new.py"], snapshot());
  // integration 目录整个跑；test_b 文件本身；service 的三个用例去掉参数化合并成两个文件里的三个 id；views 按 import 推断到 test_b 的用例，但 test_b 已整文件跑，不再单列
  assert.deepEqual(s.args, ["integration", "tests/unit/test_b.py", "tests/unit/test_a.py::test_bad", "tests/unit/test_a.py::test_ok", "tests/unit/test_p.py::test_many"]);
  assert.equal(s.granularity, "case");
  assert.deepEqual(s.items.map((i) => [i.path, i.tier ?? "-", i.how]), [
    ["app/service.py", "T0", "覆盖率上下文说这些测试跑过它"],
    ["integration/conftest.py", "-", "conftest 影响整个目录"],
    ["tests/unit/test_b.py", "-", "它本身是测试文件"],
    ["web/views.py", "T1", "测试文件 import 了它"],
  ]);
  assert.deepEqual(s.skipped.map((k) => k.path), ["app/new.py", "docs/x.md"]);
  assert.equal(s.estimated, 6);
});

test("选择：命令行太长就退到按测试文件跑；删掉的测试文件不跑", () => {
  const s = selectTests(["app/service.py"], snapshot(), { maxArgChars: 40 });
  assert.deepEqual(s.args, ["tests/unit/test_a.py", "tests/unit/test_p.py"]);
  assert.equal(s.granularity, "file");
  const gone = selectTests(["tests/unit/test_b.py"], snapshot(), { exists: () => false });
  assert.deepEqual(gone.args, []);
  assert.match(gone.skipped[0]?.why ?? "", /已删除/);
  assert.equal(baseId("a.py::t[x y]"), "a.py::t");
});

test("合并：范围内的用例换成新结果，范围外保留；记下这次只跑了什么、上次全量是什么时候", () => {
  const snap = snapshot();
  const sel = selectTests(["app/service.py"], snap);
  const partialXml = `<testsuite timestamp="2026-10-27T11:00:00">
<testcase classname="tests.unit.test_a" name="test_ok" time="0.01"/>
<testcase classname="tests.unit.test_a" name="test_bad" time="0.02"/>
<testcase classname="tests.unit.test_p" name="test_many[1]" time="0"/>
<testcase classname="tests.unit.test_p" name="test_many[2]" time="0"/>
<testcase classname="tests.unit.test_p" name="test_many[3]" time="0"/>
</testsuite>`;
  const partial = parseJunit(partialXml, known, "partial/junit.xml", "x");
  const merged = mergeRuns(snap.run, partial, sel, { changed: ["app/service.py"], elapsedMs: 1234 });
  assert.deepEqual([merged.total, merged.passed, merged.failed, merged.skipped], [7, 6, 0, 1]);
  assert.equal(merged.at, "2026-10-27T11:00:00");
  assert.equal(merged.fullAt, "2026-10-27T10:00:00");
  assert.equal(merged.cases.find((c) => c.name === "test_bad")?.status, "passed");
  assert.equal(merged.cases.find((c) => c.name === "test_end_to_end")?.status, "passed");
  assert.deepEqual([merged.partial?.ran, merged.partial?.passed, merged.partial?.elapsedMs, merged.partial?.granularity], [5, 5, 1234, "case"]);
  assert.deepEqual(merged.partial?.items.map((i) => i.path), ["app/service.py"]);
  // 再合并一次：fullAt 不变
  const again = mergeRuns(merged, partial, sel, { changed: ["app/service.py"], elapsedMs: 1 });
  assert.equal(again.fullAt, "2026-10-27T10:00:00");
});

test("合并：删掉的测试文件的旧用例也拿掉", () => {
  const snap = snapshot();
  const sel = selectTests(["tests/unit/test_b.py"], snap, { exists: () => false });
  const partial = parseJunit(`<testsuite></testsuite>`, known, "p", "2026-10-27T12:00:00");
  const merged = mergeRuns(snap.run, partial, sel, { changed: ["tests/unit/test_b.py"], elapsedMs: 1, exists: () => false });
  assert.equal(merged.cases.some((c) => c.file === "tests/unit/test_b.py"), false);
  assert.equal(merged.total, 5);
});
