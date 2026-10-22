import { readOverlay, type Overlay } from "./config.ts";
import { indexFiles } from "./files.ts";
import { extractImports, buildFileEdges, detectPythonRoots, pythonTopLevelNames, readTsPaths } from "./imports.ts";
import { buildRules, checkRules, topDir } from "./rules.ts";
import { extractSymbols } from "./symbols.ts";
import { extractCalls, type CallExtraction } from "./calls.ts";
import { resolveWithPyright, pyrightServerEntry } from "./pyright.ts";
import type { FileRecord, ImportRecord, FileEdge, LayerRules, Violation, AllowedEdge, SymbolRecord } from "./types.ts";

export interface IndexOptions {
  overlayFile?: string;
  /** 是否用 pyright 做精确层；缺省：装了就用。 */
  precise?: boolean;
}

export interface PreciseStats {
  used: boolean;
  skipped: string | null;
  attempted: number;
  upgraded: number;
  externalDefinitions: number;
  elapsedMs: number;
}

export interface IndexResult {
  root: string;
  viaGit: boolean;
  overlay: Overlay;
  files: FileRecord[];
  imports: ImportRecord[];
  edges: FileEdge[];
  pythonRoots: string[];
  rules: LayerRules;
  ruleProblems: string[];
  violations: Violation[];
  allowed: AllowedEdge[];
  layeredEdges: number;
  symbols: SymbolRecord[];
  calls: CallExtraction;
  precise: PreciseStats;
}

export async function indexRepository(root: string, options: IndexOptions = {}): Promise<IndexResult> {
  const overlay = readOverlay(root, options.overlayFile);
  const { files, contents, viaGit } = await indexFiles(root, overlay.exclude);
  const pythonRoots = detectPythonRoots(files, overlay.source_roots);
  const ctx = {
    known: new Set(files.map((f) => f.path)),
    pythonRoots,
    pythonTopLevel: pythonTopLevelNames(files, pythonRoots),
    tsPaths: readTsPaths(contents),
  };
  const imports = await extractImports(files, contents, ctx);
  const edges = buildFileEdges(imports);
  const { rules, problems: ruleProblems } = await buildRules({ overlay, contents });
  const check = checkRules(edges, files, contents, rules);
  const symbols = await extractSymbols(files, contents);
  const calls = await extractCalls(files, contents, imports, symbols);
  const wantPrecise = options.precise ?? pyrightServerEntry() !== null;
  let precise: PreciseStats = { used: false, skipped: wantPrecise ? null : "未启用", attempted: 0, upgraded: 0, externalDefinitions: 0, elapsedMs: 0 };
  if (wantPrecise) {
    const r = await resolveWithPyright(root, calls.unresolved, symbols, contents);
    calls.edges.push(...r.edges);
    calls.unresolved = r.stillUnresolved;
    precise = { used: r.skipped === null, skipped: r.skipped, attempted: r.attempted, upgraded: r.edges.length, externalDefinitions: r.externalDefinitions, elapsedMs: r.elapsedMs };
  }
  return {
    root, viaGit, overlay, files, imports, edges, pythonRoots, rules, ruleProblems,
    violations: check.violations, allowed: check.allowed, layeredEdges: check.layeredEdges,
    symbols, calls, precise,
  };
}

/** 查某个符号的调用者与被调用者；query 可以是限定名、`路径::限定名`，或名字片段。 */
export function callGraphFor(result: IndexResult, query: string): { matches: SymbolRecord[]; callers: Map<string, { edge: import("./types.ts").CallEdge }[]>; callees: Map<string, { edge: import("./types.ts").CallEdge }[]> } {
  const matches = result.symbols.filter((s) => s.id === query || s.qualified === query || s.name === query || s.qualified.endsWith("." + query));
  const callers = new Map<string, { edge: import("./types.ts").CallEdge }[]>();
  const callees = new Map<string, { edge: import("./types.ts").CallEdge }[]>();
  for (const m of matches) {
    callers.set(m.id, result.calls.edges.filter((e) => e.to === m.id).map((edge) => ({ edge })));
    callees.set(m.id, result.calls.edges.filter((e) => e.from === m.id).map((edge) => ({ edge })));
  }
  return { matches, callers, callees };
}

export function summarizeSymbols(result: IndexResult, file?: string): string {
  const symbols = file ? result.symbols.filter((s) => s.path === file) : result.symbols;
  const byKind = new Map<string, number>();
  for (const s of symbols) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
  const byRes = new Map<string, number>();
  for (const e of result.calls.edges) byRes.set(e.resolution, (byRes.get(e.resolution) ?? 0) + 1);
  const kinds = new Map<string, number>();
  for (const u of result.calls.unresolved) kinds.set(u.kind, (kinds.get(u.kind) ?? 0) + 1);
  const p = result.precise;
  const lines = [
    `符号 ${symbols.length}：${[...byKind].map(([k, v]) => `${k} ${v}`).join("、")}`,
    `调用点 ${result.calls.sites}；解析到的调用边 ${result.calls.edges.length}：${[...byRes].map(([k, v]) => `${k} ${v}`).join("、")}`,
    `未解析 ${result.calls.unresolved.length}：${[...kinds].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("、")}`,
    p.used
      ? `精确层 pyright：尝试 ${p.attempted}，升级为调用边 ${p.upgraded}，定义在仓库外 ${p.externalDefinitions}，耗时 ${(p.elapsedMs / 1000).toFixed(1)} 秒`
      : `精确层：未运行（${p.skipped ?? "未知原因"}）`,
  ];
  if (file) for (const s of symbols) lines.push(`  ${s.kind.padEnd(8)} ${s.qualified}  ${s.startLine}-${s.endLine}`);
  return lines.join("\n") + "\n";
}

export function summarizeCalls(result: IndexResult, query: string): string {
  const { matches, callers, callees } = callGraphFor(result, query);
  if (!matches.length) return `没有找到符号：${query}\n`;
  const lines: string[] = [];
  const name = (id: string): string => id;
  for (const m of matches) {
    lines.push(`${m.kind} ${m.id}  ${m.startLine}-${m.endLine}`);
    const ins = callers.get(m.id) ?? [];
    lines.push(`  调用者 ${ins.length}：`);
    for (const { edge } of ins) lines.push(`    ${name(edge.from)}  @${edge.evidence.path}:${edge.evidence.line}  [${edge.resolution}]`);
    const outs = callees.get(m.id) ?? [];
    lines.push(`  被调用 ${outs.length}：`);
    for (const { edge } of outs) lines.push(`    ${name(edge.to)}  @${edge.evidence.path}:${edge.evidence.line}  [${edge.resolution}]`);
    const un = result.calls.unresolved.filter((u) => u.from === m.id);
    if (un.length) {
      lines.push(`  未解析 ${un.length}：`);
      for (const u of un) lines.push(`    ${u.callee}  @${u.path}:${u.line}  ${u.reason}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function summarize(result: IndexResult): string {
  const byLanguage = new Map<string, number>();
  for (const f of result.files) byLanguage.set(f.language, (byLanguage.get(f.language) ?? 0) + 1);
  const byStatus = new Map<string, number>();
  for (const r of result.imports) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  const dirEdges = new Map<string, number>();
  for (const e of result.edges) {
    const a = topDir(e.from);
    const b = topDir(e.to);
    if (a === b) continue;
    const key = `${a} -> ${b}`;
    dirEdges.set(key, (dirEdges.get(key) ?? 0) + e.evidence.length);
  }
  const unresolved = result.imports.filter((r) => r.status === "unresolved");
  const lines = [
    `仓库 ${result.root}（${result.viaGit ? "git" : "目录遍历"}）`,
    `文件 ${result.files.length}：${[...byLanguage].map(([k, v]) => `${k} ${v}`).join("、")}`,
    `Python 根目录：${result.pythonRoots.join("、")}`,
    `import 语句 ${result.imports.length}：${[...byStatus].map(([k, v]) => `${k} ${v}`).join("、")}`,
    `文件级 import 边 ${result.edges.length}；顶层目录间 ${dirEdges.size} 对：`,
    ...[...dirEdges].sort().map(([k, v]) => `  ${k}  ×${v}`),
  ];
  if (unresolved.length) {
    lines.push(`未解析（项目内找不到）${unresolved.length} 条，前 10：`);
    for (const r of unresolved.slice(0, 10)) lines.push(`  ${r.from}:${r.line}  ${r.spec}  ${r.reason ?? ""}`);
  }
  return lines.join("\n") + "\n";
}

export function summarizeRules(result: IndexResult): string {
  const { rules } = result;
  const lines: string[] = [];
  lines.push(`规则来源：`);
  for (const p of rules.provenance) lines.push(`  [${p.tier}] ${p.what}${p.evidence ? `  ← ${p.evidence.path}${p.evidence.line ? ":" + p.evidence.line : ""}` : ""}`);
  if (!rules.provenance.length) lines.push("  （无规则：overlay 未声明分层）");
  for (const problem of result.ruleProblems) lines.push(`  ! ${problem}`);
  lines.push(`分层：${Object.entries(rules.layers).sort((a, b) => a[1] - b[1]).map(([k, v]) => `${k}=L${v}`).join("，") || "无"}`);
  lines.push(`白名单例外：${rules.allowed.map((a) => `${a.from} → ${a.to}`).join("；") || "无"}`);
  lines.push(`零依赖包：${rules.isolated.map((i) => i.pkg).join("、") || "无"}`);
  for (const fw of rules.forbiddenWords) lines.push(`禁用词（${fw.match}）在 ${fw.dirs.join("、")}：${fw.words.join(", ")}`);
  lines.push(`受分层约束的文件级边：${result.layeredEdges}`);
  lines.push(`白名单放行：${result.allowed.length} 处`);
  for (const a of result.allowed) lines.push(`  ${a.evidence.path}:${a.evidence.line}  → ${a.to}  （${a.allowedBy ? `${a.allowedBy.path}:${a.allowedBy.line ?? ""}` : "overlay"}）`);
  lines.push(`违规：${result.violations.length} 处`);
  for (const v of result.violations) lines.push(`  [${v.rule}] ${v.evidence.path}:${v.evidence.line}  ${v.message}`);
  return lines.join("\n") + "\n";
}
