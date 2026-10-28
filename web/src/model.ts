import type { Snapshot } from "../../src/snapshot.ts";
import type { TestCase } from "../../src/tests.ts";
import type { FileRecord, SymbolRecord, CallEdge, FileEdge, Violation, AllowedEdge, ChangeRecord, UnresolvedCall, Touch } from "../../src/types.ts";
import { WORDS, dirLabel, dirShort, layerLabel, layerBadge, kindWord, changeWord, type Names, EMPTY_NAMES } from "./words.ts";

/** 多久以前，人话。 */
export function ago(at: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

export type Level = { kind: "dirs" } | { kind: "files"; dir: string } | { kind: "symbols"; file: string };

export type NodeType = "dir" | "file" | "symbol" | "portal";

export interface GNode {
  id: string;
  type: NodeType;
  label: string;
  sub?: string;
  partition: number;
  width: number;
  height: number;
  layer?: number;
  change?: ChangeRecord["status"] | "clean";
  uncommitted?: boolean;
  badges: { text: string; tone: "red" | "amber" | "green" | "blue" | "gray" | "purple" }[];
  drill?: Level;
  ref: { kind: "dir"; dir: string } | { kind: "file"; path: string } | { kind: "symbol"; id: string } | { kind: "portal"; target: Level };
  /** 这个节点代表的文件（给任务高亮用）。 */
  files: string[];
}

export type EdgeRef =
  | { kind: "dir-edge"; from: string; to: string }
  | { kind: "file-edge"; from: string; to: string }
  | { kind: "file-portal"; dir: string; otherDir: string; direction: "out" | "in" }
  | { kind: "call-edge"; from: string; to: string }
  | { kind: "call-portal"; file: string; otherFile: string; direction: "out" | "in" };

export interface GEdge {
  id: string;
  source: string;
  target: string;
  count: number;
  color: string;
  width: number;
  dashed?: boolean;
  label?: string;
  ref: EdgeRef;
}

export interface Lane {
  partition: number;
  label: string;
  tone: string;
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  lanes: Lane[];
}

export const COLORS = {
  edge: "#8a8f98",
  violation: "#c62828",
  allowed: "#ef9f27",
  call: { "same-file": "#607d8b", import: "#1976d2", self: "#2e7d32", pyright: "#7b1fa2" } as Record<string, string>,
  change: { A: "#2e7d32", M: "#b26a00", D: "#c62828", R: "#1976d2", "?": "#2e7d32", clean: "#c9cdd3" } as Record<string, string>,
};

export function topDir(p: string): string {
  const i = p.indexOf("/");
  return i < 0 ? "." : p.slice(0, i);
}

export function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** 快照的各种索引，建一次复用。 */
export class SnapshotIndex {
  readonly files = new Map<string, FileRecord>();
  readonly filesByTop = new Map<string, FileRecord[]>();
  readonly symbols = new Map<string, SymbolRecord>();
  readonly symbolsByFile = new Map<string, SymbolRecord[]>();
  readonly changes = new Map<string, ChangeRecord>();
  readonly violationsAt = new Map<string, Violation[]>();
  readonly allowedAt = new Map<string, AllowedEdge[]>();
  readonly violationsByFile = new Map<string, Violation[]>();
  readonly fileEdgesFrom = new Map<string, FileEdge[]>();
  readonly fileEdgesTo = new Map<string, FileEdge[]>();
  readonly callsFrom = new Map<string, CallEdge[]>();
  readonly callsTo = new Map<string, CallEdge[]>();
  readonly unresolvedFrom = new Map<string, UnresolvedCall[]>();
  readonly layers: Record<string, number>;
  readonly maxLayer: number;
  readonly topDirs: string[];
  readonly touched: Record<string, Touch>;
  readonly names: Names;
  readonly s: Snapshot;
  /** 测试用例按 id 查，懒建一次。 */
  private testCaseById: Map<string, TestCase> | null = null;

  constructor(s: Snapshot) {
    this.s = s;
    this.touched = s.activity?.touched ?? {};
    this.names = s.names ? { layers: s.names.layers, dirs: s.names.dirs } : EMPTY_NAMES;
    for (const f of s.files) {
      this.files.set(f.path, f);
      const top = topDir(f.path);
      const list = this.filesByTop.get(top) ?? [];
      list.push(f);
      this.filesByTop.set(top, list);
    }
    for (const sym of s.symbols) {
      this.symbols.set(sym.id, sym);
      const list = this.symbolsByFile.get(sym.path) ?? [];
      list.push(sym);
      this.symbolsByFile.set(sym.path, list);
    }
    for (const c of s.baseline?.changes ?? []) this.changes.set(c.path, c);
    for (const v of s.violations) {
      const key = `${v.evidence.path}:${v.evidence.line ?? 0}`;
      this.violationsAt.set(key, [...(this.violationsAt.get(key) ?? []), v]);
      this.violationsByFile.set(v.evidence.path, [...(this.violationsByFile.get(v.evidence.path) ?? []), v]);
    }
    for (const a of s.allowed) {
      const key = `${a.evidence.path}:${a.evidence.line ?? 0}`;
      this.allowedAt.set(key, [...(this.allowedAt.get(key) ?? []), a]);
    }
    for (const e of s.edges) {
      this.fileEdgesFrom.set(e.from, [...(this.fileEdgesFrom.get(e.from) ?? []), e]);
      this.fileEdgesTo.set(e.to, [...(this.fileEdgesTo.get(e.to) ?? []), e]);
    }
    for (const c of s.calls.edges) {
      this.callsFrom.set(c.from, [...(this.callsFrom.get(c.from) ?? []), c]);
      this.callsTo.set(c.to, [...(this.callsTo.get(c.to) ?? []), c]);
    }
    for (const u of s.calls.unresolved) this.unresolvedFrom.set(u.from, [...(this.unresolvedFrom.get(u.from) ?? []), u]);
    this.layers = s.rules.layers;
    this.maxLayer = Math.max(0, ...Object.values(this.layers));
    this.topDirs = [...this.filesByTop.keys()].sort();
  }

  changeOf(path: string): { status: ChangeRecord["status"] | "clean"; uncommitted: boolean } {
    const c = this.changes.get(path);
    return c ? { status: c.status, uncommitted: !c.committed } : { status: "clean", uncommitted: false };
  }

  changedCount(files: FileRecord[]): { changed: number; uncommitted: number } {
    let changed = 0;
    let uncommitted = 0;
    for (const f of files) {
      const c = this.changes.get(f.path);
      if (c) {
        changed++;
        if (!c.committed) uncommitted++;
      }
    }
    return { changed, uncommitted };
  }

  /** 顶层目录的分区：上游（测试、脚本）→ L 高 → L 低 → 资源（文档、配置）。 */
  partitionOf(dir: string): number {
    const layer = this.layers[dir];
    if (layer !== undefined) return 1 + (this.maxLayer - layer);
    const dependsOnLayered = this.s.dirEdges.some((e) => e.from === dir && this.layers[e.to] !== undefined);
    return dependsOnLayered ? 0 : this.maxLayer + 2;
  }

  laneLabel(partition: number): string {
    if (partition === 0) return "用到分层代码的测试和脚本（上游，不在分层内）";
    if (partition === this.maxLayer + 2) return "文档、配置这类资源（没有分层依赖）";
    const layer = this.maxLayer - (partition - 1);
    const dirs = Object.entries(this.layers).filter(([, l]) => l === layer).map(([d]) => d);
    return layerLabel(layer, dirs, this.names);
  }

  fileEdgeTone(e: FileEdge): { color: string; violations: number; allowed: number } {
    let violations = 0;
    let allowed = 0;
    for (const ev of e.evidence) {
      const key = `${ev.path}:${ev.line ?? 0}`;
      if (this.violationsAt.has(key)) violations++;
      if (this.allowedAt.has(key)) allowed++;
    }
    return { color: violations ? COLORS.violation : allowed ? COLORS.allowed : COLORS.edge, violations, allowed };
  }

  /** 构成一条目录级边的全部文件级边。 */
  fileEdgesBetweenDirs(from: string, to: string): FileEdge[] {
    return this.s.edges.filter((e) => topDir(e.from) === from && topDir(e.to) === to);
  }

  testCase(id: string): TestCase | undefined {
    if (!this.testCaseById) this.testCaseById = new Map((this.s.tests?.run?.cases ?? []).map((c) => [c.id, c]));
    return this.testCaseById.get(id);
  }

  /** 一组文件的测试徽章：有失败就红；否则给覆盖率或相关测试数。同一个测试跑过几个文件只算一次。 */
  testBadge(paths: string[]): GNode["badges"][number] | undefined {
    const t = this.s.tests;
    if (!t?.run) return undefined;
    let failed = 0;
    let passed = 0;
    let covSum = 0;
    let covN = 0;
    const seen = new Set<string>();
    for (const p of paths) {
      const st = t.fileStatus[p];
      if (!st) continue;
      for (const id of st.related) {
        if (seen.has(id)) continue;
        seen.add(id);
        const c = this.testCase(id);
        if (!c) continue;
        if (c.status === "failed" || c.status === "error") failed++;
        else if (c.status === "passed") passed++;
      }
      if (st.coverage && st.coverage.total > 0) {
        covSum += st.coverage.percent;
        covN++;
      }
    }
    if (failed) return { text: `相关测试失败 ${failed} 个`, tone: "red" };
    if (paths.length === 1 && covN) return { text: `测试跑到 ${Math.round(covSum)}%（覆盖率）${passed ? ` · ${passed} 个测试通过` : ""}`, tone: "green" };
    if (covN) return { text: `平均覆盖率 ${Math.round(covSum / covN)}%`, tone: "green" };
    if (passed) return { text: `${passed} 个相关测试通过`, tone: "green" };
    return undefined;
  }
}

const SIZE = { dir: { width: 230, height: 84 }, file: { width: 240, height: 64 }, symbol: { width: 250, height: 54 }, portal: { width: 200, height: 48 } };

function edgeWidth(count: number): number {
  return Math.min(6, 1 + Math.log2(1 + count));
}

export function buildGraph(ix: SnapshotIndex, level: Level): Graph {
  if (level.kind === "dirs") return dirGraph(ix);
  if (level.kind === "files") return fileGraph(ix, level.dir);
  return symbolGraph(ix, level.file);
}

function dirGraph(ix: SnapshotIndex): Graph {
  const nodes: GNode[] = [];
  const lanes = new Map<number, Lane>();
  for (const dir of ix.topDirs) {
    const files = ix.filesByTop.get(dir) ?? [];
    const partition = ix.partitionOf(dir);
    const layer = ix.layers[dir];
    const { changed, uncommitted } = ix.changedCount(files);
    const violations = ix.s.violations.filter((v) => topDir(v.evidence.path) === dir).length;
    const badges: GNode["badges"] = [];
    if (layer !== undefined) badges.push({ text: layerBadge(layer, ix.names), tone: "blue" });
    if (violations) badges.push({ text: WORDS.violations(violations), tone: "red" });
    if (changed) badges.push({ text: WORDS.changedFiles(changed, uncommitted), tone: "amber" });
    const touchedHere = files.filter((f) => ix.touched[f.path]).length;
    if (touchedHere) badges.push({ text: WORDS.touched(touchedHere), tone: "purple" });
    const tb = ix.testBadge(files.map((f) => f.path));
    if (tb) badges.push(tb);
    nodes.push({
      id: `dir:${dir}`,
      type: "dir",
      label: dirLabel(dir, ix.names),
      sub: `${files.length} 个文件`,
      partition,
      ...SIZE.dir,
      ...(layer !== undefined ? { layer } : {}),
      change: changed ? "M" : "clean",
      badges,
      drill: { kind: "files", dir },
      ref: { kind: "dir", dir },
      files: files.map((f) => f.path),
    });
    if (!lanes.has(partition)) lanes.set(partition, { partition, label: ix.laneLabel(partition), tone: layer !== undefined ? `l${layer}` : partition === 0 ? "up" : "res" });
  }
  const edges: GEdge[] = ix.s.dirEdges.map((e) => ({
    id: `de:${e.from}>${e.to}`,
    source: `dir:${e.from}`,
    target: `dir:${e.to}`,
    count: e.count,
    color: e.violations ? COLORS.violation : e.allowed ? COLORS.allowed : COLORS.edge,
    width: edgeWidth(e.count),
    label: e.violations ? WORDS.importEdgeViolations(e.count, e.violations) : e.allowed ? WORDS.importEdgeAllowed(e.count, e.allowed) : WORDS.importEdge(e.count),
    ref: { kind: "dir-edge", from: e.from, to: e.to },
  }));
  return { nodes, edges, lanes: [...lanes.values()].sort((a, b) => a.partition - b.partition) };
}

function fileGraph(ix: SnapshotIndex, dir: string): Graph {
  const files = ix.filesByTop.get(dir) ?? [];
  const inSet = new Set(files.map((f) => f.path));
  const nodes: GNode[] = [];
  for (const f of files) {
    const change = ix.changeOf(f.path);
    const symbols = ix.symbolsByFile.get(f.path)?.length ?? 0;
    const violations = ix.violationsByFile.get(f.path)?.length ?? 0;
    const badges: GNode["badges"] = [];
    if (violations) badges.push({ text: WORDS.violations(violations), tone: "red" });
    if (change.status !== "clean") badges.push({ text: changeWord(change.status, change.uncommitted), tone: change.status === "D" ? "red" : "amber" });
    const touch = ix.touched[f.path];
    if (touch) badges.push({ text: `Claude 刚改过 · ${ago(touch.at)}${touch.session ? ` · 会话 ${touch.session}` : ""}`, tone: "purple" });
    const tb = ix.testBadge([f.path]);
    if (tb) badges.push(tb);
    if (symbols) badges.push({ text: WORDS.symbols(symbols), tone: "gray" });
    nodes.push({
      id: `file:${f.path}`,
      type: "file",
      label: basename(f.path),
      sub: f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) + "/" : f.language,
      partition: 1,
      ...SIZE.file,
      change: change.status,
      uncommitted: change.uncommitted,
      badges,
      ...(symbols ? { drill: { kind: "symbols", file: f.path } } : {}),
      ref: { kind: "file", path: f.path },
      files: [f.path],
    });
  }
  const edges = new Map<string, GEdge>();
  const portalIn = new Map<string, number>();
  const portalOut = new Map<string, { count: number; violations: number; allowed: number }>();
  for (const e of ix.s.edges) {
    const a = inSet.has(e.from);
    const b = inSet.has(e.to);
    if (!a && !b) continue;
    const tone = ix.fileEdgeTone(e);
    if (a && b) {
      const id = `fe:${e.from}>${e.to}`;
      edges.set(id, { id, source: `file:${e.from}`, target: `file:${e.to}`, count: e.evidence.length, color: tone.color, width: edgeWidth(e.evidence.length), ...(tone.violations ? { label: `越层 ${tone.violations}` } : tone.allowed ? { label: "白名单放行" } : {}), ref: { kind: "file-edge", from: e.from, to: e.to } });
    } else if (a) {
      const other = topDir(e.to);
      const p = portalOut.get(other) ?? { count: 0, violations: 0, allowed: 0 };
      p.count += e.evidence.length;
      p.violations += tone.violations;
      p.allowed += tone.allowed;
      portalOut.set(other, p);
      const id = `fe:${e.from}>portal:${other}`;
      const prev = edges.get(id);
      const count = (prev?.count ?? 0) + e.evidence.length;
      edges.set(id, { id, source: `file:${e.from}`, target: `portal:out:${other}`, count, color: tone.violations ? COLORS.violation : tone.allowed ? COLORS.allowed : prev?.color ?? COLORS.edge, width: edgeWidth(count), ref: { kind: "file-portal", dir, otherDir: other, direction: "out" } });
    } else {
      const other = topDir(e.from);
      portalIn.set(other, (portalIn.get(other) ?? 0) + e.evidence.length);
      const id = `fe:portal:${other}>${e.to}`;
      const prev = edges.get(id);
      const count = (prev?.count ?? 0) + e.evidence.length;
      edges.set(id, { id, source: `portal:in:${other}`, target: `file:${e.to}`, count, color: prev?.color ?? COLORS.edge, width: edgeWidth(count), ref: { kind: "file-portal", dir, otherDir: other, direction: "in" } });
    }
  }
  for (const [other, count] of portalIn) {
    nodes.push({ id: `portal:in:${other}`, type: "portal", label: dirLabel(other, ix.names), sub: `${count} 处 import 进来`, partition: 0, ...SIZE.portal, badges: [], ref: { kind: "portal", target: { kind: "files", dir: other } }, files: [] });
  }
  for (const [other, p] of portalOut) {
    const badges: GNode["badges"] = [];
    if (p.violations) badges.push({ text: `越层 ${p.violations}`, tone: "red" });
    if (p.allowed) badges.push({ text: `白名单放行 ${p.allowed}`, tone: "amber" });
    nodes.push({ id: `portal:out:${other}`, type: "portal", label: dirLabel(other, ix.names), sub: `${p.count} 处 import 出去`, partition: 2, ...SIZE.portal, badges, ref: { kind: "portal", target: { kind: "files", dir: other } }, files: [] });
  }
  const lanes: Lane[] = [];
  if (portalIn.size) lanes.push({ partition: 0, label: "谁用了这个目录（被 import）", tone: "up" });
  lanes.push({ partition: 1, label: `${dirShort(dir, ix.names)}（${dir === "." ? "根目录" : dir + "/"}）`, tone: ix.layers[dir] !== undefined ? `l${ix.layers[dir]}` : "res" });
  if (portalOut.size) lanes.push({ partition: 2, label: "这个目录用了谁（import 出去）", tone: "res" });
  return { nodes, edges: [...edges.values()], lanes };
}

function symbolGraph(ix: SnapshotIndex, file: string): Graph {
  const symbols = ix.symbolsByFile.get(file) ?? [];
  const ids = new Set(symbols.map((s) => s.id));
  const moduleId = `${file}::<module>`;
  const nodes: GNode[] = [];
  const hasModuleCalls = (ix.callsFrom.get(moduleId)?.length ?? 0) > 0;
  if (hasModuleCalls) {
    ids.add(moduleId);
    nodes.push({ id: `sym:${moduleId}`, type: "symbol", label: "文件顶层的代码（<module>）", sub: basename(file), partition: 1, ...SIZE.symbol, badges: [{ text: "不在任何函数里", tone: "gray" }], ref: { kind: "symbol", id: moduleId }, files: [file] });
  }
  for (const s of symbols) {
    const callers = ix.callsTo.get(s.id)?.length ?? 0;
    const callees = ix.callsFrom.get(s.id)?.length ?? 0;
    const unresolved = ix.unresolvedFrom.get(s.id)?.filter((u) => u.kind === "needs-types" || u.kind === "inherited" || u.kind === "unknown-name").length ?? 0;
    const badges: GNode["badges"] = [{ text: kindWord(s.kind), tone: s.kind === "class" ? "purple" : "gray" }];
    if (callers) badges.push({ text: WORDS.callers(callers), tone: "blue" });
    if (unresolved) badges.push({ text: WORDS.unresolved(unresolved), tone: "amber" });
    nodes.push({ id: `sym:${s.id}`, type: "symbol", label: s.qualified, sub: `第 ${s.startLine}–${s.endLine} 行${callees ? ` · 调用了别人 ${callees} 次` : ""}`, partition: 1, ...SIZE.symbol, badges, ref: { kind: "symbol", id: s.id }, files: [file] });
  }
  const edges = new Map<string, GEdge>();
  const portalIn = new Map<string, number>();
  const portalOut = new Map<string, number>();
  const bump = (id: string, make: () => GEdge): void => {
    const prev = edges.get(id);
    if (prev) {
      prev.count++;
      prev.width = edgeWidth(prev.count);
      prev.label = `${prev.count} 次`;
    } else edges.set(id, make());
  };
  for (const c of ix.s.calls.edges) {
    const a = ids.has(c.from);
    const b = ids.has(c.to);
    if (!a && !b) continue;
    const color = COLORS.call[c.resolution] ?? COLORS.edge;
    const dashed = c.resolution === "pyright";
    if (a && b) bump(`ce:${c.from}>${c.to}`, () => ({ id: `ce:${c.from}>${c.to}`, source: `sym:${c.from}`, target: `sym:${c.to}`, count: 1, color, width: 1.5, dashed, ref: { kind: "call-edge", from: c.from, to: c.to } }));
    else if (a) {
      const other = c.to.split("::")[0] ?? "";
      portalOut.set(other, (portalOut.get(other) ?? 0) + 1);
      bump(`ce:${c.from}>portal:${other}`, () => ({ id: `ce:${c.from}>portal:${other}`, source: `sym:${c.from}`, target: `portal:out:${other}`, count: 1, color, width: 1.5, dashed, ref: { kind: "call-portal", file, otherFile: other, direction: "out" } }));
    } else {
      const other = c.from.split("::")[0] ?? "";
      portalIn.set(other, (portalIn.get(other) ?? 0) + 1);
      bump(`ce:portal:${other}>${c.to}`, () => ({ id: `ce:portal:${other}>${c.to}`, source: `portal:in:${other}`, target: `sym:${c.to}`, count: 1, color, width: 1.5, dashed, ref: { kind: "call-portal", file, otherFile: other, direction: "in" } }));
    }
  }
  for (const [other, count] of portalIn) nodes.push({ id: `portal:in:${other}`, type: "portal", label: basename(other), sub: `${other} · 调用进来 ${count} 次`, partition: 0, ...SIZE.portal, badges: [], ref: { kind: "portal", target: { kind: "symbols", file: other } }, files: [other] });
  for (const [other, count] of portalOut) nodes.push({ id: `portal:out:${other}`, type: "portal", label: basename(other), sub: `${other} · 调用出去 ${count} 次`, partition: 2, ...SIZE.portal, badges: [], ref: { kind: "portal", target: { kind: "symbols", file: other } }, files: [other] });
  const lanes: Lane[] = [];
  if (portalIn.size) lanes.push({ partition: 0, label: "谁调用了这个文件里的函数（调用者）", tone: "up" });
  lanes.push({ partition: 1, label: `${basename(file)} 里的函数和类（${file}）`, tone: "res" });
  if (portalOut.size) lanes.push({ partition: 2, label: "这个文件调用了谁（被调用者）", tone: "res" });
  return { nodes, edges: [...edges.values()], lanes };
}

export { kindWord as kindText, changeWord as changeText };
