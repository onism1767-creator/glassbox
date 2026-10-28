import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { indexRepository } from "../src/index.ts";
import { nodeTable, validateAnnotations, applyAnnotations, annotationSnapshot, annotationTodo, readAnnotations, lineCounter, type NodeWorld } from "../src/annotations.ts";

const fixtures = path.join(import.meta.dirname, "fixtures");
let repo = "";
let state = "";
let world: NodeWorld;

async function index(): Promise<NodeWorld> {
  const r = await indexRepository(repo, { overlayFile: path.join(fixtures, "mini-py-overlay.yaml"), precise: false });
  return { files: r.files, symbols: r.symbols, edges: r.edges, layers: r.rules.layers };
}

before(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "glassbox-ann-"));
  state = fs.mkdtempSync(path.join(os.tmpdir(), "glassbox-ann-state-"));
  fs.cpSync(path.join(fixtures, "mini-py"), repo, { recursive: true });
  world = await index();
});
after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(state, { recursive: true, force: true });
});

const ctx = () => ({ lineCount: lineCounter(repo), author: "test", now: "2026-10-27T12:00:00Z" });

test("节点表：目录按文件清单、文件按内容、函数或类按自己的源码算哈希", () => {
  const t = nodeTable(world);
  assert.ok(t.get("dir:app"));
  assert.ok(t.get("file:app/service.py"));
  const run = t.get("sym:app/service.py::run")!;
  assert.equal(run.kind, "symbol");
  assert.match(run.hashBasis, /自己的源码/);
  assert.notEqual(run.hash, t.get("file:app/service.py")!.hash);
});

test("校验：节点不存在、依据不在节点里、行号超出、哈希过期、重复、缺字段都退回并说原因；对的收下", () => {
  const t = nodeTable(world);
  const svc = t.get("file:app/service.py")!.hash;
  const run = t.get("sym:app/service.py::run")!;
  const r = validateAnnotations(
    [
      { node: "file:app/service.py", name: "业务入口", role: "把核心模型包一层给网页用", basis: [{ path: "app/service.py", line: 1 }], hash: svc },
      { node: "file:app/nothing.py", name: "x", role: "y", basis: [{ path: "app/service.py", line: 1 }], hash: "z" },
      { node: "dir:app", name: "应用层", role: "业务逻辑", basis: [{ path: "core/models.py", line: 1 }], hash: t.get("dir:app")!.hash },
      { node: "file:app/service.py", name: "重复", role: "重复", basis: [{ path: "app/service.py", line: 1 }], hash: svc },
      { node: "file:app/models.py", name: "模型", role: "数据结构", basis: [{ path: "app/models.py", line: 999 }], hash: t.get("file:app/models.py")!.hash },
      { node: "file:app/models.py", name: "模型", role: "数据结构", basis: [{ path: "app/models.py", line: 1 }], hash: "stale" },
      { node: run.node, name: "跑一次", role: "返回一个核心模型实例", basis: [{ path: "app/service.py" }], hash: run.hash },
      { node: run.node, name: "跑一次", role: "返回一个核心模型实例", basis: [{ path: "app/service.py", line: run.symbol!.startLine }], hash: run.hash },
      { node: "dir:core", name: "核心", role: "已验证的核心", basis: [{ path: "core/models.py", line: 1 }], hash: t.get("dir:core")!.hash },
      { node: "dir:core", name: "核心", basis: [{ path: "core/models.py", line: 1 }], hash: t.get("dir:core")!.hash },
    ],
    t,
    ctx(),
  );
  assert.deepEqual(r.accepted.map((a) => a.node), ["file:app/service.py", "sym:app/service.py::run"]);
  const reasons = r.rejected.map((x) => `${x.index}:${x.reason.slice(0, 6)}`);
  assert.deepEqual(reasons, ["1:节点不存在：", "2:依据不在这个", "3:同一批里重复", "4:依据的行号超", "5:过期：你读的", "6:函数或类的依", "8:标注里不能写", "9:缺 role"]);
  assert.equal(r.accepted[0]?.author, "test");
});

test("写入、状态、待办：收下的进文件；改了文件后它的标注过时、目录不过时；待办先目录再被 import 多的文件", async () => {
  const t = nodeTable(world);
  const r = applyAnnotations(state, world, { items: [
    { node: "file:app/service.py", name: "业务入口", role: "把核心模型包一层给网页用", basis: [{ path: "app/service.py", line: 1 }], hash: t.get("file:app/service.py")!.hash },
    { node: "dir:app", name: "应用层", role: "业务逻辑", basis: [{ path: "app/service.py", line: 1 }], hash: t.get("dir:app")!.hash },
  ] }, ctx());
  assert.equal(r.accepted.length, 2);
  assert.equal(readAnnotations(state).items.length, 2);
  let snap = annotationSnapshot(state, world);
  assert.deepEqual([snap.summary.total, snap.summary.fresh, snap.summary.stale], [2, 2, 0]);
  const todo = annotationTodo(world, readAnnotations(state).items);
  assert.equal(todo[0]?.kind, "dir");
  assert.ok(!todo.some((x) => x.node === "dir:app" || x.node === "file:app/service.py"));
  const files = todo.filter((x) => x.kind === "file");
  assert.ok((files[0]?.importedBy ?? 0) >= (files[files.length - 1]?.importedBy ?? 0));
  assert.equal(todo.find((x) => x.node === "file:app/models.py")?.dirName, "应用层");

  fs.appendFileSync(path.join(repo, "app", "service.py"), "\n# changed\n");
  world = await index();
  snap = annotationSnapshot(state, world);
  assert.equal(snap.items.find((v) => v.node === "file:app/service.py")?.status, "stale");
  assert.equal(snap.items.find((v) => v.node === "dir:app")?.status, "fresh");
  const again = annotationTodo(world, readAnnotations(state).items, { kind: "file", dir: "app" });
  const item = again.find((x) => x.node === "file:app/service.py");
  assert.equal(item?.why, "stale");
  assert.equal(item?.previous?.name, "业务入口");

  fs.rmSync(path.join(repo, "app", "service.py"));
  world = await index();
  snap = annotationSnapshot(state, world);
  assert.equal(snap.items.find((v) => v.node === "file:app/service.py")?.status, "orphan");
  assert.equal(snap.items.find((v) => v.node === "dir:app")?.status, "stale");
});
