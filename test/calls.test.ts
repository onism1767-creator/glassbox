import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { indexRepository } from "../src/index.ts";

const fixtures = path.join(import.meta.dirname, "fixtures");
const syntactic = { precise: false };

test("符号：函数、类、方法的限定名与范围", async () => {
  const result = await indexRepository(path.join(fixtures, "mini-calls"), syntactic);
  const tool = result.symbols.filter((s) => s.path === "other/tool.py").map((s) => [s.kind, s.qualified, s.startLine, s.endLine]);
  assert.deepEqual(tool, [
    ["class", "Tool", 1, 6],
    ["method", "Tool.run", 2, 3],
    ["method", "Tool.step", 5, 6],
    ["function", "helper", 9, 10],
  ]);
  const app = result.symbols.find((s) => s.qualified === "App.go");
  assert.equal(app?.parent, "App");
  assert.equal(app?.kind, "method");
});

test("调用：导入别名、模块别名、包再导出、同文件、self、构造函数各自解析，并标明解析方式", async () => {
  const result = await indexRepository(path.join(fixtures, "mini-calls"), syntactic);
  const edges = result.calls.edges.map((e) => [e.from, e.to, e.evidence.line, e.resolution]);
  const main = "pkg/main.py::main";
  assert.deepEqual(edges.filter((e) => e[0] === main), [
    [main, "other/tool.py::helper", 7, "import"],
    [main, "other/tool.py::helper", 8, "import"],
    [main, "other/tool.py::Tool", 9, "import"],
    [main, "other/tool.py::Tool", 11, "import"],
  ]);
  assert.deepEqual(edges.filter((e) => e[0] === "pkg/main.py::App.go"), [["pkg/main.py::App.go", "pkg/main.py::App.main2", 18, "self"]]);
  assert.deepEqual(edges.filter((e) => e[0] === "pkg/main.py::App.main2"), [["pkg/main.py::App.main2", "pkg/main.py::main", 22, "same-file"]]);
  assert.deepEqual(edges.filter((e) => e[0] === "pkg/main.py::<module>"), [["pkg/main.py::<module>", "pkg/main.py::main", 25, "same-file"]]);
  assert.deepEqual(edges.filter((e) => e[0] === "other/tool.py::Tool.run"), [["other/tool.py::Tool.run", "other/tool.py::Tool.step", 3, "self"]]);
});

test("解不到的调用老实列出原因与类别，不猜", async () => {
  const result = await indexRepository(path.join(fixtures, "mini-calls"), syntactic);
  const byLine = Object.fromEntries(result.calls.unresolved.filter((u) => u.path === "pkg/main.py").map((u) => [u.line, u]));
  assert.equal(byLine[10]?.kind, "needs-types");
  assert.equal(byLine[12]?.kind, "unknown-name");
  assert.equal(byLine[19]?.kind, "inherited");
  assert.equal(byLine[26]?.kind, "builtin");
  assert.equal(byLine[10]?.col, 6);
  assert.equal(result.calls.sites, 12);
  assert.equal(result.precise.used, false);
});

test("精确层：pyright 把实例方法调用升级成调用边，内置与外部库不再算未解析", async () => {
  const result = await indexRepository(path.join(fixtures, "mini-calls"), { precise: true });
  assert.equal(result.precise.used, true, result.precise.skipped ?? "");
  const upgraded = result.calls.edges.filter((e) => e.resolution === "pyright").map((e) => [e.from, e.to, e.evidence.line]);
  assert.deepEqual(upgraded, [["pkg/main.py::main", "other/tool.py::Tool.run", 10]]);
  const left = result.calls.unresolved.filter((u) => u.path === "pkg/main.py").map((u) => [u.line, u.kind] as const).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(left, [[12, "unknown-name"], [19, "inherited"], [26, "builtin"]]);
});
