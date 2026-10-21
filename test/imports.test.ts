import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { indexRepository } from "../src/index.ts";

const fixtures = path.join(import.meta.dirname, "fixtures");

test("Python：src 布局、相对导入、外部依赖、项目内未解析各归其位", async () => {
  const result = await indexRepository(path.join(fixtures, "mini-src"));
  assert.deepEqual(result.pythonRoots, [".", "src"]);
  const from = (spec: string) => result.imports.find((r) => r.from === "src/pkg/a.py" && r.spec === spec);
  assert.equal(from("os")?.status, "external");
  assert.equal(from("pkg.b")?.resolved, "src/pkg/b.py");
  assert.equal(from(".c")?.resolved, "src/pkg/c.py");
  assert.equal(from(".sub.d")?.resolved, "src/pkg/sub/d.py");
  assert.equal(from("pkg.missing")?.status, "unresolved");
  const deep = result.imports.find((r) => r.from === "src/pkg/sub/d.py");
  assert.equal(deep?.level, 2);
  assert.equal(deep?.resolved, "src/pkg/b.py");
});

test("JS/TS：相对路径、index 文件、.js 后缀映射、tsconfig 别名、require、动态 import、外部包", async () => {
  const result = await indexRepository(path.join(fixtures, "mini-js"));
  const targets = result.edges.filter((e) => e.from === "src/main.ts").map((e) => e.to).sort();
  assert.deepEqual(targets, ["src/app/b.ts", "src/lib/a.ts", "src/lib/c.cjs", "src/lib/d.ts", "src/lib/index.ts"]);
  const external = result.imports.filter((r) => r.status === "external").map((r) => r.spec);
  assert.deepEqual(external, ["node:fs"]);
  assert.equal(result.imports.filter((r) => r.status === "unresolved").length, 0);
});

test("每条边都带文件与行号证据", async () => {
  const result = await indexRepository(path.join(fixtures, "mini-js"));
  for (const edge of result.edges) {
    assert.ok(edge.evidence.length > 0);
    for (const ev of edge.evidence) {
      assert.equal(ev.path, edge.from);
      assert.ok(typeof ev.line === "number" && ev.line >= 1);
    }
  }
});
