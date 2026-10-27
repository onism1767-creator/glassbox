import fs from "node:fs";
import path from "node:path";
import { Indexer, type IndexOptions, type IndexResult, type PreciseStats } from "./indexer.ts";
import { readHistory, stageTimeline, hotspots, changeCoupling, type StageEntry, type Hotspot } from "./history.ts";
import { readBaseline, diffSinceBaseline, currentHead, type DiffResult } from "./baseline.ts";
import { topDir } from "./rules.ts";
import { git } from "./files.ts";
import { writeFacts } from "./store.ts";
import { computeTech, type TechStack } from "./tech.ts";
import { parseEmojiList, readStandardTasks, type TaskRecord } from "./tasks.ts";
import { computeAllProgress, computeGauge, findInconsistencies, type TaskProgress, type StageGauge, type Inconsistency } from "./progress.ts";
import { readTestResults, type TestSnapshot, type AutoTestState } from "./tests.ts";
import type { FileRecord, ImportRecord, FileEdge, LayerRules, Violation, AllowedEdge, CommitRecord, Tier, SymbolRecord, CallEdge, UnresolvedCall, ActivityEvent, Touch } from "./types.ts";

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
  symbols: SymbolRecord[];
  calls: { edges: CallEdge[]; unresolved: UnresolvedCall[]; sites: number; precise: PreciseStats };
  history: {
    commits: CommitRecord[];
    stages: StageEntry[];
    latestStage?: string;
    hotspots: Hotspot[];
    coupling: { a: string; b: string; together: number }[];
  };
  baseline?: DiffResult;
  activity?: { events: ActivityEvent[]; touched: Record<string, Touch> };
  /** 人话名字，来自 overlay，T2 声明。 */
  names: { layers: Record<string, string>; dirs: Record<string, string>; tier: Tier };
  /** 用到的技术：声明的依赖对照实际 import。 */
  tech: TechStack;
  /** 测试结果：junit 与 coverage。 */
  tests?: TestSnapshot;
  /** 任务：声明层（任务文件）+ 证据层（进度信号、阶段对照、不一致）。 */
  tasks?: {
    source: { file: string; format: "emoji-list" | "standard"; tier: Tier; readAt?: string };
    items: TaskRecord[];
    progress: Record<string, TaskProgress>;
    gauge: StageGauge;
    inconsistencies: Inconsistency[];
  };
  /** 这次快照相对上一次重新解析了哪些文件。 */
  changedFiles?: string[];
  elapsedMs?: number;
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

export async function readSource(root: string): Promise<Snapshot["source"]> {
  try {
    const head = await currentHead(root);
    const dirty = Boolean((await git(root, ["status", "--porcelain"])).trim());
    return { ...head, dirty };
  } catch {
    return { commit: null, branch: null, dirty: false };
  }
}

export interface AssembleInput {
  root: string;
  result: IndexResult;
  commits: CommitRecord[];
  source: Snapshot["source"];
  baseline?: DiffResult;
  activity?: Snapshot["activity"];
  /** .workbench/tasks 这类 standard 任务目录。 */
  standardTasksDir?: string;
  /** 状态目录，用来找 test-results。 */
  stateDir?: string;
  /** 自动跑相关测试的开关状态（serve 时才有）。 */
  autoTest?: AutoTestState;
}

function buildTasks(input: AssembleInput, tests: TestSnapshot | undefined): Snapshot["tasks"] | undefined {
  const { result, commits, baseline, activity, standardTasksDir } = input;
  let items: TaskRecord[] = [];
  let source: NonNullable<Snapshot["tasks"]>["source"] | null = null;
  if (result.taskSource) {
    items = result.taskSource.format === "standard" ? [] : parseEmojiList(result.taskSource.file, result.taskSource.text);
    source = { file: result.taskSource.file, format: result.taskSource.format, tier: "T2" };
  }
  if (standardTasksDir) {
    const std = readStandardTasks(standardTasksDir);
    if (std.length) {
      items = [...items, ...std];
      source ??= { file: ".workbench/tasks", format: "standard", tier: "T2" };
    }
  }
  if (!source) return undefined;
  const map = computeAllProgress(items, { commits, changes: baseline?.changes ?? [], touched: activity?.touched ?? {}, ...(tests ? { tests } : {}) });
  const progress: Record<string, TaskProgress> = Object.fromEntries(map);
  const gauge = computeGauge(items, commits, map);
  return { source: { ...source, readAt: new Date().toISOString() }, items, progress, gauge, inconsistencies: findInconsistencies(items, map, gauge) };
}

/** 把索引结果、历史、基线、活动拼成快照；纯计算。 */
export function assembleSnapshot(input: AssembleInput): Snapshot {
  const { root, result, commits, source, baseline, activity } = input;
  const stages = stageTimeline(commits);
  const latest = stages[stages.length - 1];
  const layersTier: Tier = result.rules.provenance.find((p) => p.what === "layers")?.tier ?? "T2";
  const tests = input.stateDir ? readTestResults(root, input.stateDir, new Set(result.files.map((f) => f.path)), result.edges, result.overlay.test_results ?? {}) : undefined;
  if (tests && input.autoTest) tests.auto = input.autoTest;
  const tasks = buildTasks(input, tests);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root,
    source,
    tiers: {
      files: "T0", imports: "T0", edges: "T0", "modules.dir": "T1", "modules.layer": layersTier,
      dirEdges: "T1", violations: "T1", allowed: "T1", "history.commits": "T0", "history.stages": "T0",
      "history.hotspots": "T1", "history.coupling": "T1", "baseline.changes": "T0",
      symbols: "T0", "calls.edges": "T0", "calls.unresolved": "T0", "activity.events": "T0",
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
    symbols: result.symbols,
    calls: { edges: result.calls.edges, unresolved: result.calls.unresolved, sites: result.calls.sites, precise: result.precise },
    history: {
      commits,
      stages,
      ...(latest ? { latestStage: latest.stage } : {}),
      hotspots: hotspots(commits, 30),
      coupling: changeCoupling(commits, 30),
    },
    ...(baseline ? { baseline } : {}),
    ...(activity ? { activity } : {}),
    names: { layers: result.overlay.names?.layers ?? {}, dirs: result.overlay.names?.dirs ?? {}, tier: "T2" },
    tech: computeTech(result.imports, result.manifests),
    ...(tests ? { tests } : {}),
    ...(tasks ? { tasks } : {}),
    changedFiles: result.changedFiles,
    elapsedMs: result.elapsedMs,
  };
}

export async function buildSnapshot(root: string, options: SnapshotOptions): Promise<Snapshot> {
  const indexer = new Indexer(root, options);
  try {
    const result = await indexer.run();
    const commits = await readHistory(root, { stageTag: result.overlay.stage_tag, ...(options.maxCommits ? { max: options.maxCommits } : {}) });
    const source = await readSource(root);
    let baseline: DiffResult | undefined;
    const b = readBaseline(options.stateDir);
    if (b && source.commit) {
      try {
        baseline = await diffSinceBaseline(root, b);
      } catch {
        baseline = undefined;
      }
    }
    return assembleSnapshot({ root, result, commits, source, ...(baseline ? { baseline } : {}), standardTasksDir: path.join(options.stateDir, "tasks"), stateDir: options.stateDir });
  } finally {
    await indexer.close();
  }
}

/** 原子写：先写临时文件再改名，读的一方永远看到完整 JSON。 */
export function writeSnapshotJson(stateDir: string, snapshot: Snapshot): string {
  fs.mkdirSync(stateDir, { recursive: true });
  const jsonPath = path.join(stateDir, "snapshot.json");
  const tmp = jsonPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(snapshot), "utf8");
  fs.renameSync(tmp, jsonPath);
  return jsonPath;
}

export async function writeSnapshot(root: string, options: SnapshotOptions): Promise<{ snapshot: Snapshot; jsonPath: string; dbPath: string }> {
  const snapshot = await buildSnapshot(root, options);
  const jsonPath = writeSnapshotJson(options.stateDir, snapshot);
  const dbPath = path.join(options.stateDir, "facts.sqlite");
  writeFacts(dbPath, snapshot);
  return { snapshot, jsonPath, dbPath };
}

export function summarizeSnapshot(s: Snapshot): string {
  const lines = [
    `快照 ${s.generatedAt.slice(0, 19)}  ${s.source.commit?.slice(0, 9) ?? "无 git"}${s.source.branch ? " " + s.source.branch : ""}${s.source.dirty ? "（工作区有改动）" : ""}`,
    `文件 ${s.files.length}，目录模块 ${s.modules.length}，文件级边 ${s.edges.length}，顶层目录对 ${s.dirEdges.length}`,
    `分层 ${Object.keys(s.rules.layers).length} 个包；违规 ${s.violations.length}，白名单放行 ${s.allowed.length}`,
    `符号 ${s.symbols.length}，调用点 ${s.calls.sites}，调用边 ${s.calls.edges.length}（pyright 升级 ${s.calls.precise.upgraded}），未解析 ${s.calls.unresolved.length}`,
    `提交 ${s.history.commits.length}，阶段 ${s.history.stages.length}${s.history.latestStage ? `，最新 ${s.history.latestStage}` : ""}`,
    s.baseline ? `基线 ${s.baseline.baseline.commit.slice(0, 9)} 之后：${s.baseline.commitsSince} 个提交，${s.baseline.changes.length} 个文件变更` : "基线：未记录",
    `耗时 ${((s.elapsedMs ?? 0) / 1000).toFixed(1)} 秒`,
  ];
  return lines.join("\n") + "\n";
}
