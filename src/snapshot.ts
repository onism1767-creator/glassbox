import fs from "node:fs";
import path from "node:path";
import { indexRepository, type IndexOptions, type IndexResult } from "./index.ts";
import { readHistory, stageTimeline, hotspots, changeCoupling, type StageEntry, type Hotspot } from "./history.ts";
import { readBaseline, diffSinceBaseline, currentHead, type DiffResult } from "./baseline.ts";
import { topDir } from "./rules.ts";
import { git } from "./files.ts";
import { writeFacts } from "./store.ts";
import type { FileRecord, ImportRecord, FileEdge, LayerRules, Violation, AllowedEdge, CommitRecord, Tier } from "./types.ts";

export interface DirModule {
  id: string;
  dir: string;
  top: string;
  layer?: number;
  files: number;
  languages: Record<string, number>;
}

export interface DirEdge {
  from: string;
  to: string;
  count: number;
  allowed: number;
  violations: number;
}

export interface Snapshot {
  schemaVersion: 1;
  generatedAt: string;
  root: string;
  source: { commit: string | null; branch: string | null; dirty: boolean };
  /** 每个字段的真相等级，画布按它着色。 */
  tiers: Record<string, Tier>;
  files: FileRecord[];
  modules: DirModule[];
  imports: ImportRecord[];
  edges: FileEdge[];
  dirEdges: DirEdge[];
  rules: LayerRules;
  ruleProblems: string[];
  violations: Violation[];
  allowed: AllowedEdge[];
  history: {
    commits: CommitRecord[];
    stages: StageEntry[];
    latestStage?: string;
    hotspots: Hotspot[];
    coupling: { a: string; b: string; together: number }[];
  };
  baseline?: DiffResult;
}

export interface SnapshotOptions extends IndexOptions {
  stateDir: string;
  maxCommits?: number;
}

export function dirModules(result: IndexResult): DirModule[] {
  const map = new Map<string, DirModule>();
  for (const f of result.files) {
    const dir = f.dir;
    const top = topDir(f.path);
    const m = map.get(dir) ?? { id: dir, dir, top, files: 0, languages: {} };
    const layer = result.rules.layers[top];
    if (layer !== undefined) m.layer = layer;
    m.files++;
    m.languages[f.language] = (m.languages[f.language] ?? 0) + 1;
    map.set(dir, m);
  }
  return [...map.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

export function dirEdges(result: IndexResult): DirEdge[] {
  const map = new Map<string, DirEdge>();
  const allowedKeys = new Set(result.allowed.map((a) => `${a.evidence.path}:${a.evidence.line}`));
  const violationKeys = new Set(result.violations.filter((v) => v.to).map((v) => `${v.evidence.path}:${v.evidence.line}`));
  for (const e of result.edges) {
    const a = topDir(e.from);
    const b = topDir(e.to);
    if (a === b) continue;
    const key = `${a}\u0000${b}`;
    const entry = map.get(key) ?? { from: a, to: b, count: 0, allowed: 0, violations: 0 };
    for (const ev of e.evidence) {
      entry.count++;
      const k = `${ev.path}:${ev.line}`;
      if (allowedKeys.has(k)) entry.allowed++;
      if (violationKeys.has(k)) entry.violations++;
    }
    map.set(key, entry);
  }
  return [...map.values()].sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
}

export async function buildSnapshot(root: string, options: SnapshotOptions): Promise<Snapshot> {
  const result = await indexRepository(root, options);
  const commits = await readHistory(root, { stageTag: result.overlay.stage_tag, ...(options.maxCommits ? { max: options.maxCommits } : {}) });
  const stages = stageTimeline(commits);
  let source: Snapshot["source"] = { commit: null, branch: null, dirty: false };
  try {
    const head = await currentHead(root);
    const dirty = Boolean((await git(root, ["status", "--porcelain"])).trim());
    source = { ...head, dirty };
  } catch {
    /* 非 git 仓库 */
  }
  let baseline: DiffResult | undefined;
  const b = readBaseline(options.stateDir);
  if (b && source.commit) {
    try {
      baseline = await diffSinceBaseline(root, b);
    } catch {
      baseline = undefined;
    }
  }
  const latest = stages[stages.length - 1];
  const layersTier: Tier = result.rules.provenance.find((p) => p.what === "layers")?.tier ?? "T2";
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root,
    source,
    tiers: {
      files: "T0", imports: "T0", edges: "T0", "modules.dir": "T1", "modules.layer": layersTier,
      dirEdges: "T1", violations: "T1", allowed: "T1", "history.commits": "T0", "history.stages": "T0",
      "history.hotspots": "T1", "history.coupling": "T1", "baseline.changes": "T0",
    },
    files: result.files,
    modules: dirModules(result),
    imports: result.imports,
    edges: result.edges,
    dirEdges: dirEdges(result),
    rules: result.rules,
    ruleProblems: result.ruleProblems,
    violations: result.violations,
    allowed: result.allowed,
    history: {
      commits,
      stages,
      ...(latest ? { latestStage: latest.stage } : {}),
      hotspots: hotspots(commits, 30),
      coupling: changeCoupling(commits, 30),
    },
    ...(baseline ? { baseline } : {}),
  };
}

export async function writeSnapshot(root: string, options: SnapshotOptions): Promise<{ snapshot: Snapshot; jsonPath: string; dbPath: string }> {
  const snapshot = await buildSnapshot(root, options);
  fs.mkdirSync(options.stateDir, { recursive: true });
  const jsonPath = path.join(options.stateDir, "snapshot.json");
  const dbPath = path.join(options.stateDir, "facts.sqlite");
  fs.writeFileSync(jsonPath, JSON.stringify(snapshot, null, 1), "utf8");
  writeFacts(dbPath, snapshot);
  return { snapshot, jsonPath, dbPath };
}

export function summarizeSnapshot(s: Snapshot): string {
  const lines = [
    `快照 ${s.generatedAt.slice(0, 19)}  ${s.source.commit?.slice(0, 9) ?? "无 git"}${s.source.branch ? " " + s.source.branch : ""}${s.source.dirty ? "（工作区有改动）" : ""}`,
    `文件 ${s.files.length}，目录模块 ${s.modules.length}，文件级边 ${s.edges.length}，顶层目录对 ${s.dirEdges.length}`,
    `分层 ${Object.keys(s.rules.layers).length} 个包；违规 ${s.violations.length}，白名单放行 ${s.allowed.length}`,
    `提交 ${s.history.commits.length}，阶段 ${s.history.stages.length}${s.history.latestStage ? `，最新 ${s.history.latestStage}` : ""}`,
    s.baseline ? `基线 ${s.baseline.baseline.commit.slice(0, 9)} 之后：${s.baseline.commitsSince} 个提交，${s.baseline.changes.length} 个文件变更` : "基线：未记录",
  ];
  return lines.join("\n") + "\n";
}
