import { test } from "node:test";
import assert from "node:assert/strict";
import { SnapshotIndex } from "../web/src/model.ts";
import type { Snapshot } from "../src/snapshot.ts";
import { parseJunit, parseCoverage, linkTests } from "../src/tests.ts";

/** 只给 SnapshotIndex 的构造函数要碰的字段。 */
function fakeSnapshot(tests: Snapshot["tests"]): Snapshot {
  return {
    files: [],
    symbols: [],
    violations: [],
    allowed: [],
    edges: [],
    dirEdges: [],
    calls: { edges: [], unresolved: [] },
    rules: { layers: {} },
    names: { layers: {}, dirs: {}, tier: "T2" },
    tests,
  } as unknown as Snapshot;
}

const junit = `<testsuite timestamp="2026-10-27T10:00:00"><testcase classname="tests.test_a" name="test_ok" time="0"/><testcase classname="tests.test_a" name="test_bad" time="0"><failure message="boom"/></testcase></testsuite>`;
const known = new Set(["tests/test_a.py", "app/a.py", "app/b.py", "app/c.py"]);
const coverage = JSON.stringify({
  meta: { show_contexts: true },
  files: {
    "app/a.py": { summary: { covered_lines: 1, num_statements: 1, percent_covered: 100 }, contexts: { "1": ["test_a.test_ok", "test_a.test_bad"] } },
    "app/b.py": { summary: { covered_lines: 1, num_statements: 1, percent_covered: 100 }, contexts: { "1": ["test_a.test_bad"] } },
    "app/c.py": { summary: { covered_lines: 1, num_statements: 2, percent_covered: 50 }, contexts: { "1": ["test_a.test_ok"] } },
  },
});

test("方块徽章：一个失败测试跑过几个文件，目录上只算 1 个；通过数同样按测试去重", () => {
  const run = parseJunit(junit, known, "junit.xml", "x");
  const cov = parseCoverage(coverage, "C:/repo", "c", "x");
  const { fileStatus, testFiles } = linkTests(run, cov, [], [...known]);
  const ix = new SnapshotIndex(fakeSnapshot({ run, fileStatus, testFiles, problems: [], howTo: "" }));
  // test_bad 跑过 a.py 和 b.py：失败 1 个，不是 2 个
  assert.deepEqual(ix.testBadge(["app/a.py", "app/b.py", "app/c.py"]), { text: "相关测试失败 1 个", tone: "red" });
  assert.deepEqual(ix.testBadge(["app/c.py"]), { text: "测试跑到 50%（覆盖率） · 1 个测试通过", tone: "green" });
  assert.equal(ix.testCase("tests/test_a.py::test_bad")?.status, "failed");
  assert.equal(ix.testCase("nope"), undefined);

  // 全部通过、没有覆盖率：a.py 两个测试、c.py 一个，其中 test_ok 两边都有 → 2 个，不是 3 个
  const allPass = { ...run, cases: run.cases.map((c) => ({ ...c, status: "passed" as const })), failed: 0, passed: 2 };
  const linked = linkTests(allPass, cov, [], [...known]);
  const noCov = Object.fromEntries(Object.entries(linked.fileStatus).map(([k, v]) => [k, { ...v, coverage: undefined }]));
  const ix2 = new SnapshotIndex(fakeSnapshot({ run: allPass, fileStatus: noCov, testFiles: linked.testFiles, problems: [], howTo: "" }));
  assert.deepEqual(ix2.testBadge(["app/a.py", "app/c.py"]), { text: "2 个相关测试通过", tone: "green" });
  assert.equal(ix2.testBadge(["nowhere.py"]), undefined);
});
