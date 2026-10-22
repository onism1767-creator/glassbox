import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTech, parseManifests, topLevelPackage } from "../src/tech.ts";
import type { ImportRecord } from "../src/types.ts";

const pyproject = `
[project]
name = "demo"
dependencies = [
  "httpx>=0.27",
  "PyYAML",
  "pydantic[email]~=2.0",
]

[project.optional-dependencies]
dev = ["pytest", "ruff"]

[tool.ruff]
line-length = 120
`;

test("pyproject：主依赖与可选依赖都读出来，extras 与版本号剥掉", () => {
  const d = parseManifests([{ path: "pyproject.toml", text: pyproject }]);
  assert.deepEqual(d.map((x) => [x.name, !!x.dev]), [["httpx", false], ["PyYAML", false], ["pydantic", false], ["pytest", true], ["ruff", true]]);
});

test("package.json：dependencies 与 devDependencies", () => {
  const d = parseManifests([{ path: "package.json", text: JSON.stringify({ dependencies: { react: "^19" }, devDependencies: { vite: "^7" } }) }]);
  assert.deepEqual(d.map((x) => [x.name, x.spec, !!x.dev]), [["react", "^19", false], ["vite", "^7", true]]);
});

test("顶层包名：python 点分、scoped npm 包、node: 内置", () => {
  assert.deepEqual(topLevelPackage("yaml.loader", "python"), { module: "yaml", builtin: false });
  assert.deepEqual(topLevelPackage("os.path", "python"), { module: "os", builtin: true });
  assert.deepEqual(topLevelPackage("@xyflow/react/dist", "js"), { module: "@xyflow/react", builtin: false });
  assert.deepEqual(topLevelPackage("node:fs", "js"), { module: "fs", builtin: true });
});

test("实际 import 对照声明：别名匹配、未声明、声明未用、标准库分开", () => {
  const imp = (from: string, spec: string): ImportRecord => ({ from, spec, line: 1, level: 0, status: "external" });
  const imports = [imp("a.py", "yaml"), imp("a.py", "httpx"), imp("b.py", "httpx"), imp("b.py", "os"), imp("b.py", "trafilatura")];
  const tech = computeTech(imports, [{ path: "pyproject.toml", text: pyproject }]);
  const third = tech.used.filter((u) => u.kind === "third-party").map((u) => [u.name, u.imports, u.files, !!u.declared]);
  assert.deepEqual(third, [["httpx", 2, 2, true], ["PyYAML", 1, 1, true], ["trafilatura", 1, 1, false]]);
  assert.deepEqual(tech.undeclared, ["trafilatura"]);
  assert.deepEqual(tech.unused.map((d) => d.name), ["pydantic", "pytest", "ruff"]);
  assert.deepEqual(tech.used.filter((u) => u.kind === "stdlib").map((u) => u.module), ["os"]);
});
