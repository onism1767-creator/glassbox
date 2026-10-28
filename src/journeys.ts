/**
 * 旅程：人或 AI 提出的假设——"这件事从入口开始，依次经过这几个文件或函数"。
 * 两级检验，不信 LLM：
 *   静态（T1）：相邻两步在 import / 调用图上有没有路；没有就标"断链"。
 *   动态（T3）：指定几个测试，带覆盖率跑一次，真实碰到的文件覆盖所有步骤才算"已验证"；
 *             验证时记下每步的内容哈希，之后代码变了就标"验证过时"，重跑才算。
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { CallEdge, Evidence, Tier } from "./types.ts";
import { nodeTable, type NodeInfo, type NodeWorld } from "./annotations.ts";
import type { EntryPoint } from "./entries.ts";
import type { FileTestStatus } from "./tests.ts";

export const JOURNEYS_FILE = "journeys.yaml";
export const VERIFIED_FILE = "journeys-verified.json";

export interface JourneyStep {
  /** file:… 或 sym:…（目录太粗，不收）。 */
  node: string;
  /** 这一步在做什么，一句话。 */
  note?: string;
}

export interface Journey {
  id: string;
  name: string;
  role: string;
  steps: JourneyStep[];
  /** 动态检验用的测试：pytest 的用例 id 或测试文件路径。 */
  verify?: { tests: string[] };
  author: string;
  at: string;
}

/** 机器写的验证记录（T3 的依据）。 */
export interface Verification {
  id: string;
  at: string;
  tests: string[];
  /** 真实碰到的文件。 */
  touched: string[];
  passed: number;
  failed: number;
  skipped: number;
  exitCode: number;
  elapsedMs: number;
  /** 验证时每一步的内容哈希。 */
  stepHashes: Record<string, string>;
  python?: string;
}

export type LinkKind = "same" | "direct" | "path" | "reverse" | "shared-caller" | "broken" | "missing";

export interface LinkView {
  from: string;
  to: string;
  kind: LinkKind;
  /** 走过的节点（含两端），文件路径或符号 id。 */
  via: string[];
  evidence: Evidence[];
  text: string;
  tier: Tier;
}

export interface StepView extends JourneyStep {
  exists: boolean;
  file?: string;
  label: string;
  hash?: string;
  /** 验证跑过时有没有碰到。 */
  touched?: boolean;
  /** 按上次全量跑的覆盖率，指定的测试里哪些碰过它（没跑验证时的提示）。 */
  touchedBy?: string[];
  changedSinceVerify?: boolean;
}

export type JourneyStatus = "verified" | "verified-stale" | "failed" | "broken" | "hypothesis" | "invalid";

export interface JourneyView extends Journey {
  steps: StepView[];
  links: LinkView[];
  status: JourneyStatus;
  statusText: string;
  tier: Tier;
  verification?: Verification & { stepsTouched: number };
  hint?: string;
}

export interface JourneySnapshot {
  source: string;
  items: JourneyView[];
  /** 入口候选（T0），帮人挑起点。 */
  entries: EntryPoint[];
  summary: { total: number; verified: number; stale: number; failed: number; broken: number; hypothesis: number; invalid: number };
  howTo: string;
}

export const JOURNEY_HOW_TO = "写 JSON { id, name, role, steps:[{node, note}], verify:{tests:[…]} }，glassbox journey set <仓库> --file 批.json；再 glassbox journey verify <id> <仓库> 带覆盖率跑指定的测试，碰到所有步骤才算已验证（T3）。";

export function journeysPath(stateDir: string): string {
  return path.join(stateDir, JOURNEYS_FILE);
}

export function readJourneys(stateDir: string): { items: Journey[]; problems: string[] } {
  const file = journeysPath(stateDir);
  if (!fs.existsSync(file)) return { items: [], problems: [] };
  try {
    const raw = parseYaml(fs.readFileSync(file, "utf8")) as { version?: number; items?: unknown[] } | null;
    const list = Array.isArray(raw?.items) ? raw.items : [];
    const items: Journey[] = [];
    const problems: string[] = [];
    list.forEach((x, i) => {
      const j = x as Partial<Journey>;
      if (typeof j.id === "string" && typeof j.name === "string" && Array.isArray(j.steps)) {
        items.push({
          id: j.id,
          name: j.name,
          role: typeof j.role === "string" ? j.role : "",
          steps: (j.steps as JourneyStep[]).filter((s) => s && typeof s.node === "string"),
          ...(j.verify && Array.isArray(j.verify.tests) ? { verify: { tests: j.verify.tests.filter((t): t is string => typeof t === "string") } } : {}),
          author: typeof j.author === "string" ? j.author : "?",
          at: typeof j.at === "string" ? j.at : "",
        });
      } else problems.push(`第 ${i + 1} 条缺字段，跳过`);
    });
    return { items, problems };
  } catch (error) {
    return { items: [], problems: [`${JOURNEYS_FILE} 读不了：${error instanceof Error ? error.message : String(error)}`] };
  }
}

export function writeJourneys(stateDir: string, items: Journey[]): string {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = journeysPath(stateDir);
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const text = "# glassbox 旅程（T2 假设）。每条是\"从入口依次经过这些文件或函数\"的说法；静态连通和动态验证都由机器算，别在这里写\"已验证\"。\n" + stringifyYaml({ version: 1, items: sorted });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

export function readVerifications(stateDir: string): Record<string, Verification> {
  const file = path.join(stateDir, VERIFIED_FILE);
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: number; items?: Record<string, Verification> };
    return raw.version === 1 && raw.items && typeof raw.items === "object" ? raw.items : {};
  } catch {
    return {};
  }
}

export function writeVerification(stateDir: string, v: Verification): string {
  const all = readVerifications(stateDir);
  all[v.id] = v;
  const file = path.join(stateDir, VERIFIED_FILE);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: all }, null, 1), "utf8");
  fs.renameSync(tmp, file);
  return file;
}

// ── 静态检验：文件级和符号级的图 ──────────────────────────────────────────

export interface FlowGraph {
  /** 文件 → 它用到的文件 → 一条证据。import 和调用都算。 */
  out: Map<string, Map<string, Evidence>>;
  in: Map<string, Map<string, Evidence>>;
  /** 符号 → 它调用的符号 → 证据。 */
  calls: Map<string, Map<string, Evidence>>;
}

function add(map: Map<string, Map<string, Evidence>>, a: string, b: string, ev: Evidence): void {
  const inner = map.get(a) ?? new Map<string, Evidence>();
  if (!inner.has(b)) inner.set(b, ev);
  map.set(a, inner);
}

export function buildFlowGraph(world: NodeWorld, calls: CallEdge[]): FlowGraph {
  const g: FlowGraph = { out: new Map(), in: new Map(), calls: new Map() };
  for (const e of world.edges) {
    const ev = e.evidence[0] ?? { path: e.from };
    add(g.out, e.from, e.to, ev);
    add(g.in, e.to, e.from, ev);
  }
  for (const c of calls) {
    add(g.calls, c.from, c.to, c.evidence);
    const fa = c.from.split("::")[0] ?? "";
    const fb = c.to.split("::")[0] ?? "";
    if (fa && fb && fa !== fb) {
      add(g.out, fa, fb, c.evidence);
      add(g.in, fb, fa, c.evidence);
    }
  }
  return g;
}

/** 宽度优先找路，最多 maxDepth 跳；返回经过的节点和每跳的证据。 */
function bfs(map: Map<string, Map<string, Evidence>>, from: string, to: string, maxDepth: number): { via: string[]; evidence: Evidence[] } | null {
  if (from === to) return { via: [from], evidence: [] };
  const parent = new Map<string, { prev: string; ev: Evidence }>();
  let frontier = [from];
  const seen = new Set([from]);
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const [nb, ev] of map.get(cur) ?? []) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        parent.set(nb, { prev: cur, ev });
        if (nb === to) {
          const via = [to];
          const evidence: Evidence[] = [];
          let n = to;
          while (n !== from) {
            const p = parent.get(n)!;
            evidence.unshift(p.ev);
            via.unshift(p.prev);
            n = p.prev;
          }
          return { via, evidence };
        }
        next.push(nb);
      }
    }
    frontier = next;
  }
  return null;
}

const MAX_DEPTH = 4;

export function linkBetween(g: FlowGraph, a: NodeInfo, b: NodeInfo): LinkView {
  const fa = a.path!;
  const fb = b.path!;
  const base = { from: a.node, to: b.node, tier: "T1" as Tier };
  if (a.kind === "symbol" && b.kind === "symbol") {
    const r = bfs(g.calls, a.symbol!.id, b.symbol!.id, MAX_DEPTH);
    if (r) return { ...base, kind: r.via.length <= 2 ? "direct" : "path", via: r.via, evidence: r.evidence, text: r.via.length <= 2 ? "直接调用" : `调用链经过 ${r.via.length - 2} 个函数` };
  }
  if (fa === fb) return { ...base, kind: "same", via: [fa], evidence: [], text: "同一个文件" };
  const fwd = bfs(g.out, fa, fb, MAX_DEPTH);
  if (fwd) return { ...base, kind: fwd.via.length <= 2 ? "direct" : "path", via: fwd.via, evidence: fwd.evidence, text: fwd.via.length <= 2 ? "直接 import 或调用" : `经过 ${fwd.via.length - 2} 个文件` };
  // 没有正向的路时，先看有没有一个文件同时直接用到两步（调度器模式：流程由它串起来），再看反向依赖。
  for (const [c] of g.in.get(fa) ?? []) {
    const ev2 = g.in.get(fb)?.get(c);
    if (ev2) return { ...base, kind: "shared-caller", via: [fa, c, fb], evidence: [g.in.get(fa)!.get(c)!, ev2], text: `由 ${c} 串起来（它同时用到这两步）` };
  }
  const back = bfs(g.out, fb, fa, MAX_DEPTH);
  if (back) return { ...base, kind: "reverse", via: back.via, evidence: back.evidence, text: `反向：后一步${back.via.length <= 2 ? "直接" : `隔 ${back.via.length - 2} 个文件`}用到前一步（数据回流或回调）` };
  return { ...base, kind: "broken", via: [fa, fb], evidence: [], text: `断链：${MAX_DEPTH} 跳内没有 import 或调用把它们连起来` };
}

// ── 校验与写入 ───────────────────────────────────────────────────────────

export interface JourneyValidateResult {
  accepted: Journey[];
  rejected: { index: number; id?: string; reason: string }[];
}

const ID_RX = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export function validateJourneys(raw: unknown, table: Map<string, NodeInfo>, ctx: { author: string; now: string }): JourneyValidateResult {
  const list: unknown[] = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : [];
  const accepted: Journey[] = [];
  const rejected: JourneyValidateResult["rejected"] = [];
  const seen = new Set<string>();
  if (!Array.isArray(raw) && !list.length) rejected.push({ index: 0, reason: "要一个 JSON 数组，或 { items: [...] }" });
  list.forEach((x, index) => {
    const j = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const id = typeof j["id"] === "string" ? j["id"].trim() : "";
    const bad = (reason: string) => rejected.push({ index, ...(id ? { id } : {}), reason });
    if (!id || !ID_RX.test(id)) return bad("id 要是小写字母、数字、- 或 _，1 到 41 个字符，像 diagnose-web");
    if (seen.has(id)) return bad(`同一批里重复：${id}`);
    const name = typeof j["name"] === "string" ? j["name"].trim() : "";
    const role = typeof j["role"] === "string" ? j["role"].trim() : "";
    if (!name || name.length > 40) return bad("name 要有，≤ 40 字");
    if (!role || role.length > 200) return bad("role 要有（这条旅程做什么、为谁），≤ 200 字");
    if (/已验证|verified/i.test(name + role)) return bad("旅程里不能写「已验证」，那是检验器算的");
    const stepsRaw = Array.isArray(j["steps"]) ? (j["steps"] as unknown[]) : [];
    if (stepsRaw.length < 2) return bad("steps 至少两步");
    if (stepsRaw.length > 30) return bad("steps 最多 30 步");
    const steps: JourneyStep[] = [];
    for (const s of stepsRaw) {
      const o = (s && typeof s === "object" ? s : typeof s === "string" ? { node: s } : {}) as Record<string, unknown>;
      const node = typeof o["node"] === "string" ? o["node"].trim() : "";
      if (!node) return bad("每一步要有 node");
      const info = table.get(node);
      if (!info) return bad(`步骤不存在：${node}（file:… 或 sym:…，用 glassbox annotate todo 或 symbols 看）`);
      if (info.kind === "dir") return bad(`步骤不能是目录：${node}，用文件或函数`);
      if (steps.length && steps[steps.length - 1]!.node === node) return bad(`相邻两步重复：${node}`);
      const note = typeof o["note"] === "string" ? o["note"].trim().slice(0, 80) : "";
      steps.push({ node, ...(note ? { note } : {}) });
    }
    let verify: Journey["verify"] | undefined;
    const v = j["verify"];
    if (v !== undefined) {
      const tests = v && typeof v === "object" && Array.isArray((v as { tests?: unknown }).tests) ? ((v as { tests: unknown[] }).tests) : Array.isArray(v) ? v : null;
      if (!tests) return bad("verify 要是 { tests: [...] }");
      const clean = tests.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim().replace(/\\/g, "/"));
      if (!clean.length || clean.length > 20) return bad("verify.tests 要 1 到 20 个测试（用例 id 或测试文件）");
      for (const t of clean) {
        const file = t.split("::")[0] ?? t;
        if (/\.py$/.test(file) && !table.has(`file:${file}`)) return bad(`verify 的测试文件不在索引里：${file}`);
      }
      verify = { tests: clean };
    }
    seen.add(id);
    accepted.push({ id, name, role, steps, ...(verify ? { verify } : {}), author: typeof j["author"] === "string" && j["author"] ? j["author"].slice(0, 40) : ctx.author, at: ctx.now });
  });
  return { accepted, rejected };
}

export function applyJourneys(stateDir: string, world: NodeWorld, raw: unknown, ctx: { author: string; now: string }): JourneyValidateResult & { file: string; total: number } {
  const table = nodeTable(world);
  const r = validateJourneys(raw, table, ctx);
  const { items } = readJourneys(stateDir);
  const byId = new Map(items.map((j) => [j.id, j]));
  for (const j of r.accepted) byId.set(j.id, j);
  const all = [...byId.values()];
  const file = r.accepted.length ? writeJourneys(stateDir, all) : journeysPath(stateDir);
  return { ...r, file, total: all.length };
}

// ── 快照：每条旅程现在是什么状态 ─────────────────────────────────────────

/** 一个指定的测试碰没碰过某文件：verify.tests 里可能是用例 id 或测试文件；related 里是用例 id。 */
function testMatches(spec: string, related: string[]): string[] {
  const base = spec.replace(/\[.*\]$/, "");
  return related.filter((id) => id === spec || id.replace(/\[.*\]$/, "") === base || (!spec.includes("::") && id.startsWith(spec + "::")));
}

function stepLabel(info: NodeInfo | undefined, node: string): string {
  if (!info) return node;
  if (info.kind === "symbol") return `${info.symbol!.qualified}（${info.path}）`;
  return info.path ?? node;
}

export function journeySnapshot(
  stateDir: string,
  world: NodeWorld,
  calls: CallEdge[],
  entries: EntryPoint[],
  fileStatus: Record<string, FileTestStatus> | undefined,
  rel: (p: string) => string = (p) => p,
): JourneySnapshot {
  const { items, problems } = readJourneys(stateDir);
  const table = nodeTable(world);
  const verified = readVerifications(stateDir);
  const graph = buildFlowGraph(world, calls);
  const views: JourneyView[] = items.map((j) => {
    const v = verified[j.id];
    const touched = v ? new Set(v.touched) : null;
    const steps: StepView[] = j.steps.map((s) => {
      const info = table.get(s.node);
      const file = info?.path;
      const view: StepView = { ...s, exists: Boolean(info), label: stepLabel(info, s.node), ...(file ? { file } : {}), ...(info ? { hash: info.hash } : {}) };
      if (touched && file) {
        view.touched = touched.has(file);
        view.changedSinceVerify = v!.stepHashes[s.node] !== undefined && v!.stepHashes[s.node] !== info?.hash;
      } else if (j.verify?.tests.length && file && fileStatus?.[file]?.tier === "T0") {
        const by = [...new Set(j.verify.tests.flatMap((t) => testMatches(t, fileStatus[file]!.related)))];
        view.touchedBy = by;
      }
      return view;
    });
    const links: LinkView[] = [];
    for (let i = 0; i + 1 < j.steps.length; i++) {
      const a = table.get(j.steps[i]!.node);
      const b = table.get(j.steps[i + 1]!.node);
      if (!a || !b) links.push({ from: j.steps[i]!.node, to: j.steps[i + 1]!.node, kind: "missing", via: [], evidence: [], text: "有一步不存在", tier: "T1" });
      else links.push(linkBetween(graph, a, b));
    }
    const missing = steps.filter((s) => !s.exists).length;
    const broken = links.filter((l) => l.kind === "broken").length;
    let status: JourneyStatus;
    let statusText: string;
    let tier: Tier = "T2";
    let hint: string | undefined;
    let verification: JourneyView["verification"] | undefined;
    if (missing) {
      status = "invalid";
      statusText = `${missing} 步指向的代码已经不存在，先改旅程`;
    } else if (v) {
      const stepsTouched = steps.filter((s) => s.touched).length;
      verification = { ...v, stepsTouched };
      const changed = steps.filter((s) => s.changedSinceVerify).length;
      if (v.failed === 0 && v.exitCode === 0 && stepsTouched === steps.length) {
        if (changed) {
          status = "verified-stale";
          statusText = `验证时 ${v.tests.length} 个测试跑到了全部 ${steps.length} 步，但之后有 ${changed} 步的代码变了，重跑才算`;
          tier = "T2";
        } else {
          status = "verified";
          statusText = `${v.tests.length} 个测试带覆盖率跑过，真实碰到了全部 ${steps.length} 步`;
          tier = "T3";
        }
      } else {
        status = "failed";
        statusText = v.failed ? `${v.failed} 个测试失败` : v.exitCode !== 0 ? `pytest 退出码 ${v.exitCode}` : `测试只碰到了 ${stepsTouched} / ${steps.length} 步`;
      }
      if (broken) statusText += `；静态图上有 ${broken} 处断链（动态结果为准）`;
    } else if (broken) {
      status = "broken";
      statusText = `静态检验发现 ${broken} 处断链，${j.verify?.tests.length ? "跑动态验证看真走不走得通" : "先读代码确认"}`;
    } else {
      status = "hypothesis";
      statusText = `静态检验通过（相邻步都连得上）${j.verify?.tests.length ? "，还没跑动态验证" : "，没指定验证用的测试"}`;
      if (j.verify?.tests.length) {
        const n = steps.filter((s) => s.touchedBy?.length).length;
        if (fileStatus) hint = `按上次全量跑的覆盖率，指定的测试碰到了 ${n} / ${steps.length} 步；跑 glassbox journey verify ${j.id} 才算 T3`;
      }
    }
    return { ...j, steps, links, status, statusText, tier, ...(verification ? { verification } : {}), ...(hint ? { hint } : {}) };
  });
  const count = (s: JourneyStatus) => views.filter((x) => x.status === s).length;
  return {
    source: rel(journeysPath(stateDir)),
    items: views,
    entries,
    summary: { total: views.length, verified: count("verified"), stale: count("verified-stale"), failed: count("failed"), broken: count("broken"), hypothesis: count("hypothesis"), invalid: count("invalid") },
    howTo: problems.length ? `${problems.join("；")}。${JOURNEY_HOW_TO}` : JOURNEY_HOW_TO,
  };
}
