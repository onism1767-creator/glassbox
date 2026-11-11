import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { indexRepository } from "../src/index.ts";
import { applyAnnotations, lineCounter, nodeTable, pruneOrphans, readAnnotations } from "../src/annotations.ts";

test("prune：节点没了的标注删掉，别的原样保留；dry-run 只报不删", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "glassbox-prune-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "glassbox-prune-state-"));
  try {
    fs.writeFileSync(path.join(repo, "a.py"), "def f():\n    return 1\n");
    fs.writeFileSync(path.join(repo, "b.py"), "def g():\n    return 2\n");
    const world = async () => {
      const r = await indexRepository(repo, { precise: false });
      return { files: r.files, symbols: r.symbols, edges: r.edges, layers: r.rules.layers };
    };
    let w = await world();
    let table = nodeTable(w);
    const ctx = { lineCount: lineCounter(repo), author: "t", now: "2026-01-01T00:00:00Z" };
    const res = applyAnnotations(state, w, [
      { node: "file:a.py", name: "甲", role: "甲文件", basis: [{ path: "a.py", line: 1 }], hash: table.get("file:a.py")!.hash },
      { node: "sym:b.py::g", name: "乙函数", role: "返回 2", basis: [{ path: "b.py", line: 1 }], hash: table.get("sym:b.py::g")!.hash },
    ], ctx);
    assert.equal(res.accepted.length, 2, JSON.stringify(res.rejected));

    fs.rmSync(path.join(repo, "a.py"));
    w = await world();
    table = nodeTable(w);
    const dry = pruneOrphans(state, (n) => table.has(n), true);
    assert.deepEqual(dry.removed.map((a) => a.node), ["file:a.py"]);
    assert.equal(readAnnotations(state).items.length, 2, "dry-run 不动文件");

    const real = pruneOrphans(state, (n) => table.has(n));
    assert.equal(real.kept, 1);
    assert.deepEqual(readAnnotations(state).items.map((a) => a.node), ["sym:b.py::g"]);
    assert.equal(pruneOrphans(state, (n) => table.has(n)).removed.length, 0, "再清一次没东西可删");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
});
