/** `glassbox journey …`：旅程协议的命令行入口。服务开着就走 HTTP，没开就本地索引一次。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexRepository, type IndexOptions, type IndexResult } from "./index.ts";
import { readTestResults } from "./tests.ts";
import { applyJourneys, journeySnapshot, readJourneys, writeVerification, JOURNEY_HOW_TO, type JourneySnapshot, type JourneyValidateResult, type JourneyView } from "./journeys.ts";
import { verifyJourney } from "./journey-verify.ts";
import type { NodeWorld } from "./annotations.ts";

export interface JourneyCliOptions extends IndexOptions {
  stateDir: string;
  python?: string;
  port: number;
  noServer: boolean;
  json: boolean;
  id?: string;
  input?: string;
  author: string;
  out: (text: string) => void;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    try {
      p = fs.realpathSync(p);
    } catch {
      /* 保持原样 */
    }
    return p.split("\\").join("/").replace(/\/+$/, "").toLowerCase();
  };
  return norm(a) === norm(b);
}

async function server(root: string, port: number): Promise<string | null> {
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${base}/api/journeys`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = (await res.json()) as { root?: string };
    return body.root && samePath(body.root, root) ? base : null;
  } catch {
    return null;
  }
}

async function local(root: string, o: JourneyCliOptions): Promise<{ result: IndexResult; world: NodeWorld; snapshot: () => JourneySnapshot }> {
  const result = await indexRepository(root, { ...(o.overlayFile ? { overlayFile: o.overlayFile } : {}), ...(o.precise === false ? { precise: false } : {}) });
  const world: NodeWorld = { files: result.files, symbols: result.symbols, edges: result.edges, layers: result.rules.layers };
  const tests = readTestResults(root, o.stateDir, new Set(result.files.map((f) => f.path)), result.edges, result.overlay.test_results ?? {});
  return { result, world, snapshot: () => journeySnapshot(o.stateDir, world, result.calls.edges, result.entries, tests.fileStatus) };
}

const STATUS_WORD: Record<JourneyView["status"], string> = { verified: "已验证 T3", "verified-stale": "验证过时", failed: "验证没过", broken: "断链", hypothesis: "假设", invalid: "步骤不存在" };

export function formatList(s: JourneySnapshot): string {
  if (!s.items.length) return `还没有旅程。${JOURNEY_HOW_TO}\n入口候选 ${s.entries.length} 个，用 glassbox journey entries 看。\n`;
  const lines = [`旅程 ${s.summary.total} 条：已验证 ${s.summary.verified}、验证过时 ${s.summary.stale}、验证没过 ${s.summary.failed}、断链 ${s.summary.broken}、假设 ${s.summary.hypothesis}（${s.source}）`];
  for (const j of s.items) {
    lines.push(`\n[${STATUS_WORD[j.status]}] ${j.id}  ${j.name}：${j.role}`);
    lines.push(`  ${j.statusText}${j.hint ? `；${j.hint}` : ""}`);
    j.steps.forEach((st, i) => {
      const mark = st.touched === true ? "●" : st.touched === false ? "○" : " ";
      lines.push(`  ${mark} ${i + 1}. ${st.label}${st.note ? `  ${st.note}` : ""}${st.changedSinceVerify ? "  （验证后代码变了）" : ""}${!st.exists ? "  （不存在）" : ""}`);
      const link = j.links[i];
      if (link) lines.push(`     ${link.kind === "broken" || link.kind === "missing" ? "✗" : "↓"} ${link.text}${link.via.length > 2 ? `：${link.via.join(" → ")}` : ""}`);
    });
    if (j.verify?.tests.length) lines.push(`  验证用的测试：${j.verify.tests.join("、")}`);
  }
  return lines.join("\n") + "\n";
}

export function formatApply(r: { accepted: string[]; rejected: JourneyValidateResult["rejected"]; total: number; file: string }): string {
  const lines = [`收下 ${r.accepted.length} 条，退回 ${r.rejected.length} 条；旅程文件现在共 ${r.total} 条（${r.file}）`];
  for (const n of r.accepted) lines.push(`  ✓ ${n}`);
  for (const x of r.rejected) lines.push(`  ✗ 第 ${x.index + 1} 条${x.id ? ` ${x.id}` : ""}：${x.reason}`);
  return lines.join("\n") + "\n";
}

export async function journeyCommand(sub: string, root: string, o: JourneyCliOptions): Promise<void> {
  const base = o.noServer ? null : await server(root, o.port);
  if (sub === "list" || sub === "entries") {
    const s: JourneySnapshot = base ? ((await (await fetch(`${base}/api/journeys`)).json()) as JourneySnapshot) : (await local(root, o)).snapshot();
    if (sub === "entries") {
      if (o.json) return o.out(JSON.stringify({ via: base ?? "local", entries: s.entries }, null, 1) + "\n");
      const lines = [`入口候选 ${s.entries.length} 个（正则扫出来的，T0）：`];
      for (const e of s.entries) lines.push(`  ${e.text}  ${e.path}:${e.line}${e.symbol ? `  ${e.symbol}()` : ""}`);
      return o.out(lines.join("\n") + "\n");
    }
    return o.out(o.json ? JSON.stringify({ via: base ?? "local", ...s }, null, 1) + "\n" : formatList(s));
  }
  if (sub === "set") {
    const text = o.input ? fs.readFileSync(o.input, "utf8") : fs.readFileSync(0, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`批文件不是 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
    let report: { accepted: string[]; rejected: JourneyValidateResult["rejected"]; total: number; file: string };
    if (base) {
      const items = Array.isArray(parsed) ? parsed : ((parsed as { items?: unknown[] })?.items ?? []);
      const res = await fetch(`${base}/api/journeys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items, author: o.author }) });
      if (!res.ok) throw new Error(`服务拒绝：${res.status} ${await res.text()}`);
      report = (await res.json()) as typeof report;
    } else {
      const { world } = await local(root, o);
      const r = applyJourneys(o.stateDir, world, parsed, { author: o.author, now: new Date().toISOString() });
      report = { accepted: r.accepted.map((j) => j.id), rejected: r.rejected, total: r.total, file: r.file };
    }
    o.out(o.json ? JSON.stringify({ via: base ?? "local", ...report }, null, 1) + "\n" : formatApply(report));
    if (report.rejected.length && !report.accepted.length) process.exitCode = 1;
    return;
  }
  if (sub === "verify") {
    if (!o.id) throw new Error("用法: glassbox journey verify <id> [仓库]");
    if (base) {
      const res = await fetch(`${base}/api/journeys/verify?id=${encodeURIComponent(o.id)}`, { method: "POST" });
      const body = (await res.json()) as { error?: string; verification?: { touched: string[]; passed: number; failed: number; elapsedMs: number }; status?: string; statusText?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? `服务返回 ${res.status}`);
      const v = body.verification!;
      o.out(o.json ? JSON.stringify({ via: base, ...body }, null, 1) + "\n" : `跑了 ${v.passed + v.failed} 个测试（通过 ${v.passed}、失败 ${v.failed}），碰到 ${v.touched.length} 个文件，${(v.elapsedMs / 1000).toFixed(1)} 秒\n结论：${body.statusText}\n`);
      if (body.status !== "verified") process.exitCode = 1;
      return;
    }
    const { world, snapshot } = await local(root, o);
    const journey = readJourneys(o.stateDir).items.find((j) => j.id === o.id);
    if (!journey) throw new Error(`没有这条旅程：${o.id}`);
    const v = await verifyJourney(root, world, journey, { stateDir: o.stateDir, ...(o.python ? { python: o.python } : {}), log: (l) => o.out(l + "\n") });
    writeVerification(o.stateDir, v);
    const view = snapshot().items.find((j) => j.id === o.id);
    o.out(o.json ? JSON.stringify({ via: "local", verification: v, status: view?.status, statusText: view?.statusText }, null, 1) + "\n" : `跑了 ${v.passed + v.failed} 个测试（通过 ${v.passed}、失败 ${v.failed}），碰到 ${v.touched.length} 个文件，${(v.elapsedMs / 1000).toFixed(1)} 秒\n结论：${view?.statusText}\n`);
    if (view?.status !== "verified") process.exitCode = 1;
    return;
  }
  if (sub === "skill") {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "glassbox-journey", "SKILL.md");
    const dst = path.join(root, ".claude", "skills", "glassbox-journey", "SKILL.md");
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    o.out(`已装到 ${dst}\n`);
    return;
  }
  throw new Error("用法: glassbox journey list|set|verify|entries|skill [仓库]");
}
