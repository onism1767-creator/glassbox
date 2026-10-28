import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { indexRepository, type IndexResult } from "../src/index.ts";
import { nodeTable, type NodeWorld } from "../src/annotations.ts";
import { buildFlowGraph, linkBetween, validateJourneys, applyJourneys, journeySnapshot, writeVerification, readJourneys } from "../src/journeys.ts";
import { extractEntryPoints } from "../src/entries.ts";

const fixtures = path.join(import.meta.dirname, "fixtures");
let repo = "";
let state = "";
let result: IndexResult;
let world: NodeWorld;

async function index(): Promise<void> {
  result = await indexRepository(repo, { overlayFile: path.join(fixtures, "mini-py-overlay.yaml"), precise: false });
  world = { files: result.files, symbols: result.symbols, edges: result.edges, layers: result.rules.layers };
}

before(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "glassbox-jr-"));
  state = fs.mkdtempSync(path.join(os.tmpdir(), "glassbox-jr-state-"));
  fs.cpSync(path.join(fixtures, "mini-py"), repo, { recursive: true });
  await index();
});
after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(state, { recursive: true, force: true });
});

const ctx = { author: "test", now: "2026-10-27T12:00:00Z" };

test("入口候选：路由、命令、main 守卫、main 函数都认，JS 路由也认", () => {
  const py = extractEntryPoints("report/routes.py", `from fastapi import APIRouter\nrouter = APIRouter()\n\n@router.get("/diagnose")\nasync def diagnose_page(req):\n    pass\n\n@cli.command()\ndef calibrate():\n    pass\n\ndef main(argv=None):\n    pass\n\nif __name__ == "__main__":\n    main()\n`, "python");
  assert.deepEqual(py.map((e) => [e.kind, e.text, e.line, e.symbol]), [["route", "GET /diagnose", 4, "diagnose_page"], ["command", "命令 calibrate", 8, "calibrate"], ["cli", "main()", 12, "main"], ["main", "直接运行这个文件（__main__）", 15, undefined]]);
  const js = extractEntryPoints("server.ts", `app.get("/health", h);\nrouter.post('/jobs', create);\n`, "typescript");
  assert.deepEqual(js.map((e) => e.text), ["GET /health", "POST /jobs"]);
});

test("静态连通：直接、经过中间文件、反向、同一个调用者、断链，各带证据", () => {
  const t = nodeTable(world);
  const g = buildFlowGraph(world, result.calls.edges);
  const L = (a: string, b: string) => linkBetween(g, t.get(a)!, t.get(b)!);
  const direct = L("file:app/service.py", "file:core/models.py");
  assert.equal(direct.kind, "direct");
  assert.equal(direct.evidence[0]?.path, "app/service.py");
  const viaService = L("file:web/views.py", "file:core/models.py");
  assert.equal(viaService.kind, "path");
  assert.deepEqual(viaService.via, ["web/views.py", "app/service.py", "core/models.py"]);
  assert.equal(L("file:core/models.py", "file:app/service.py").kind, "reverse");
  const shared = L("file:core/models.py", "file:app/models.py");
  assert.equal(shared.kind, "shared-caller");
  assert.equal(shared.via[1], "app/service.py");
  assert.equal(L("file:util/text.py", "file:app/service.py").kind, "broken");
  assert.equal(L("file:app/service.py", "file:app/service.py").kind, "same");
});

test("校验：id、步数、目录步、不存在的步、验证测试文件不在索引里都退回；对的收下并写入", () => {
  const t = nodeTable(world);
  const ok = { id: "web-to-core", name: "网页到核心模型", role: "页面渲染时经过业务入口拿到核心模型", steps: [{ node: "file:web/views.py", note: "渲染" }, { node: "file:app/service.py" }, { node: "file:core/models.py" }], verify: { tests: ["tests/test_layers.py"] } };
  const r = validateJourneys(
    [
      ok,
      { ...ok, id: "Bad ID" },
      { ...ok, id: "one-step", steps: [{ node: "file:web/views.py" }] },
      { ...ok, id: "dir-step", steps: [{ node: "dir:app" }, { node: "file:core/models.py" }] },
      { ...ok, id: "ghost", steps: [{ node: "file:web/views.py" }, { node: "file:nope.py" }] },
      { ...ok, id: "no-test", verify: { tests: ["tests/test_missing.py"] } },
      { ...ok, id: "web-to-core" },
    ],
    t,
    ctx,
  );
  assert.deepEqual(r.accepted.map((j) => j.id), ["web-to-core"]);
  assert.deepEqual(r.rejected.map((x) => x.reason.slice(0, 5)), ["id 要是", "steps", "步骤不能是", "步骤不存在", "verif", "同一批里重"]);
  const applied = applyJourneys(state, world, [ok], ctx);
  assert.equal(applied.accepted.length, 1);
  assert.equal(readJourneys(state).items[0]?.steps.length, 3);
});

test("快照：没验证是假设（静态通过）；验证记录碰到全部步骤就是已验证 T3；改了一步的代码变成验证过时；少碰一步是验证没过", async () => {
  let s = journeySnapshot(state, world, result.calls.edges, result.entries, undefined);
  const j0 = s.items[0]!;
  assert.equal(j0.status, "hypothesis");
  assert.deepEqual(j0.links.map((l) => l.kind), ["direct", "direct"]);
  const t = nodeTable(world);
  const hashes = Object.fromEntries(j0.steps.map((st) => [st.node, t.get(st.node)!.hash]));
  writeVerification(state, { id: "web-to-core", at: "2026-10-27T12:30:00Z", tests: ["tests/test_layers.py"], touched: ["web/views.py", "app/service.py", "core/models.py", "app/models.py"], passed: 1, failed: 0, skipped: 0, exitCode: 0, elapsedMs: 900, stepHashes: hashes });
  s = journeySnapshot(state, world, result.calls.edges, result.entries, undefined);
  assert.equal(s.items[0]!.status, "verified");
  assert.equal(s.items[0]!.tier, "T3");
  assert.equal(s.items[0]!.verification?.stepsTouched, 3);
  assert.equal(s.summary.verified, 1);

  fs.appendFileSync(path.join(repo, "app", "service.py"), "\n# changed\n");
  await index();
  s = journeySnapshot(state, world, result.calls.edges, result.entries, undefined);
  assert.equal(s.items[0]!.status, "verified-stale");
  assert.equal(s.items[0]!.steps[1]!.changedSinceVerify, true);

  writeVerification(state, { id: "web-to-core", at: "2026-10-27T13:00:00Z", tests: ["tests/test_layers.py"], touched: ["web/views.py", "core/models.py"], passed: 1, failed: 0, skipped: 0, exitCode: 0, elapsedMs: 900, stepHashes: {} });
  s = journeySnapshot(state, world, result.calls.edges, result.entries, undefined);
  assert.equal(s.items[0]!.status, "failed");
  assert.match(s.items[0]!.statusText, /只碰到了 2 \/ 3 步/);
});
