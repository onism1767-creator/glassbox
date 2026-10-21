import { readOverlay, type Overlay } from "./config.ts";
import { indexFiles } from "./files.ts";
import { extractImports, buildFileEdges, detectPythonRoots, pythonTopLevelNames, readTsPaths } from "./imports.ts";
import { buildRules, checkRules, topDir } from "./rules.ts";
import type { FileRecord, ImportRecord, FileEdge, LayerRules, Violation, AllowedEdge } from "./types.ts";

export interface IndexOptions {
  overlayFile?: string;
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
  return {
    root, viaGit, overlay, files, imports, edges, pythonRoots, rules, ruleProblems,
    violations: check.violations, allowed: check.allowed, layeredEdges: check.layeredEdges,
  };
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
