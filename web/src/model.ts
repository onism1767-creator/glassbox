import type { Snapshot } from "../../src/snapshot.ts";
import type { FileRecord, SymbolRecord, CallEdge, FileEdge, Violation, AllowedEdge, ChangeRecord, UnresolvedCall } from "../../src/types.ts";

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
  /** 下钻目标。 */
  drill?: Level;
  ref: { kind: "dir"; dir: string } | { kind: "file"; path: string } | { kind: "symbol"; id: string } | { kind: "portal"; target: Level };
}

export interface GEdge {
  id: string;
  source: string;
  target: string;
  count: number;
  color: string;
  width: number;
  dashed?: boolean;
  label?: string;
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

  constructor(readonly s: Snapshot) {
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
    if (partition === 0) return "上游（依赖分层包，不在分层内）";
    if (partition === this.maxLayer + 2) return "资源与其他（无分层依赖）";
    const layer = this.maxLayer - (partition - 1);
    const dirs = Object.entries(this.layers).filter(([, l]) => l === layer).map(([d]) => d);
    return `L${layer} · ${dirs.join("、")}`;
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
}

const SIZE = { dir: { width: 210, height: 78 }, file: { width: 230, height: 60 }, symbol: { width: 240, height: 52 }, portal: { width: 190, height: 46 } };

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
    if (layer !== undefined) badges.push({ text: `L${layer}`, tone: "blue" });
    if (violations) badges.push({ text: `违规 ${violations}`, tone: "red" });
    if (changed) badges.push({ text: `改动 ${changed}${uncommitted ? `（${uncommitted} 未提交）` : ""}`, tone: "amber" });
    nodes.push({
      id: `dir:${dir}`,
      type: "dir",
      label: dir === "." ? "根目录" : dir,
      sub: `${files.length} 个文件`,
      partition,
      ...SIZE.dir,
      ...(layer !== undefined ? { layer } : {}),
      change: changed ? "M" : "clean",
      badges,
      drill: { kind: "files", dir },
      ref: { kind: "dir", dir },
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
    label: e.violations ? `${e.count} · 违规 ${e.violations}` : e.allowed ? `${e.count} · 白名单 ${e.allowed}` : String(e.count),
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
    if (violations) badges.push({ text: `违规 ${violations}`, tone: "red" });
    if (change.status !== "clean") badges.push({ text: changeText(change.status, change.uncommitted), tone: change.status === "D" ? "red" : "amber" });
    if (symbols) badges.push({ text: `${symbols} 符号`, tone: "gray" });
    nodes.push({
      id: `file:${f.path}`,
      type: "file",
      label: basename(f.path),
      sub: f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : f.language,
      partition: 1,
      ...SIZE.file,
      change: change.status,
      uncommitted: change.uncommitted,
      badges,
      ...(symbols ? { drill: { kind: "symbols", file: f.path } } : {}),
      ref: { kind: "file", path: f.path },
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
      edges.set(`fe:${e.from}>${e.to}`, { id: `fe:${e.from}>${e.to}`, source: `file:${e.from}`, target: `file:${e.to}`, count: e.evidence.length, color: tone.color, width: edgeWidth(e.evidence.length), ...(tone.violations ? { label: `违规 ${tone.violations}` } : tone.allowed ? { label: "白名单" } : {}) });
    } else if (a) {
      const other = topDir(e.to);
      const p = portalOut.get(other) ?? { count: 0, violations: 0, allowed: 0 };
      p.count += e.evidence.length;
      p.violations += tone.violations;
      p.allowed += tone.allowed;
      portalOut.set(other, p);
      const id = `fe:${e.from}>portal:${other}`;
      const prev = edges.get(id);
      edges.set(id, { id, source: `file:${e.from}`, target: `portal:out:${other}`, count: (prev?.count ?? 0) + e.evidence.length, color: tone.violations ? COLORS.violation : tone.allowed ? COLORS.allowed : prev?.color ?? COLORS.edge, width: edgeWidth((prev?.count ?? 0) + e.evidence.length) });
    } else {
      const other = topDir(e.from);
      portalIn.set(other, (portalIn.get(other) ?? 0) + e.evidence.length);
      const id = `fe:portal:${other}>${e.to}`;
      const prev = edges.get(id);
      edges.set(id, { id, source: `portal:in:${other}`, target: `file:${e.to}`, count: (prev?.count ?? 0) + e.evidence.length, color: prev?.color ?? COLORS.edge, width: edgeWidth((prev?.count ?? 0) + e.evidence.length) });
    }
  }
  for (const [other, count] of portalIn) {
    nodes.push({ id: `portal:in:${other}`, type: "portal", label: other === "." ? "根目录" : other, sub: `${count} 处 import 进来`, partition: 0, ...SIZE.portal, badges: [], ref: { kind: "portal", target: { kind: "files", dir: other } } });
  }
  for (const [other, p] of portalOut) {
    const badges: GNode["badges"] = [];
    if (p.violations) badges.push({ text: `违规 ${p.violations}`, tone: "red" });
    if (p.allowed) badges.push({ text: `白名单 ${p.allowed}`, tone: "amber" });
    nodes.push({ id: `portal:out:${other}`, type: "portal", label: other === "." ? "根目录" : other, sub: `${p.count} 处 import 出去`, partition: 2, ...SIZE.portal, badges, ref: { kind: "portal", target: { kind: "files", dir: other } } });
  }
  const lanes: Lane[] = [];
  if (portalIn.size) lanes.push({ partition: 0, label: "谁依赖这个目录", tone: "up" });
  lanes.push({ partition: 1, label: dir === "." ? "根目录" : `${dir}/`, tone: ix.layers[dir] !== undefined ? `l${ix.layers[dir]}` : "res" });
  if (portalOut.size) lanes.push({ partition: 2, label: "这个目录依赖谁", tone: "res" });
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
    nodes.push({ id: `sym:${moduleId}`, type: "symbol", label: "<module> 顶层代码", sub: basename(file), partition: 1, ...SIZE.symbol, badges: [{ text: "模块", tone: "gray" }], ref: { kind: "symbol", id: moduleId } });
  }
  for (const s of symbols) {
    const callers = ix.callsTo.get(s.id)?.length ?? 0;
    const callees = ix.callsFrom.get(s.id)?.length ?? 0;
    const unresolved = ix.unresolvedFrom.get(s.id)?.filter((u) => u.kind === "needs-types" || u.kind === "inherited" || u.kind === "unknown-name").length ?? 0;
    const badges: GNode["badges"] = [{ text: kindText(s.kind), tone: s.kind === "class" ? "purple" : "gray" }];
    if (callers) badges.push({ text: `被调 ${callers}`, tone: "blue" });
    if (unresolved) badges.push({ text: `未解析 ${unresolved}`, tone: "amber" });
    nodes.push({ id: `sym:${s.id}`, type: "symbol", label: s.qualified, sub: `${s.startLine}–${s.endLine} 行${callees ? ` · 调用 ${callees}` : ""}`, partition: 1, ...SIZE.symbol, badges, ref: { kind: "symbol", id: s.id } });
  }
  const edges = new Map<string, GEdge>();
  const portalIn = new Map<string, number>();
  const portalOut = new Map<string, number>();
  const bump = (id: string, make: () => GEdge): void => {
    const prev = edges.get(id);
    if (prev) {
      prev.count++;
      prev.width = edgeWidth(prev.count);
      prev.label = String(prev.count);
    } else edges.set(id, make());
  };
  for (const c of ix.s.calls.edges) {
    const a = ids.has(c.from);
    const b = ids.has(c.to);
    if (!a && !b) continue;
    const color = COLORS.call[c.resolution] ?? COLORS.edge;
    const dashed = c.resolution === "pyright";
    if (a && b) bump(`ce:${c.from}>${c.to}`, () => ({ id: `ce:${c.from}>${c.to}`, source: `sym:${c.from}`, target: `sym:${c.to}`, count: 1, color, width: 1.5, dashed }));
    else if (a) {
      const other = c.to.split("::")[0] ?? "";
      portalOut.set(other, (portalOut.get(other) ?? 0) + 1);
      bump(`ce:${c.from}>portal:${other}`, () => ({ id: `ce:${c.from}>portal:${other}`, source: `sym:${c.from}`, target: `portal:out:${other}`, count: 1, color, width: 1.5, dashed }));
    } else {
      const other = c.from.split("::")[0] ?? "";
      portalIn.set(other, (portalIn.get(other) ?? 0) + 1);
      bump(`ce:portal:${other}>${c.to}`, () => ({ id: `ce:portal:${other}>${c.to}`, source: `portal:in:${other}`, target: `sym:${c.to}`, count: 1, color, width: 1.5, dashed }));
    }
  }
  for (const [other, count] of portalIn) nodes.push({ id: `portal:in:${other}`, type: "portal", label: basename(other), sub: `${other} · ${count} 次调用进来`, partition: 0, ...SIZE.portal, badges: [], ref: { kind: "portal", target: { kind: "symbols", file: other } } });
  for (const [other, count] of portalOut) nodes.push({ id: `portal:out:${other}`, type: "portal", label: basename(other), sub: `${other} · ${count} 次调用出去`, partition: 2, ...SIZE.portal, badges: [], ref: { kind: "portal", target: { kind: "symbols", file: other } } });
  const lanes: Lane[] = [];
  if (portalIn.size) lanes.push({ partition: 0, label: "谁调用这个文件里的符号", tone: "up" });
  lanes.push({ partition: 1, label: file, tone: "res" });
  if (portalOut.size) lanes.push({ partition: 2, label: "这个文件调用了谁", tone: "res" });
  return { nodes, edges: [...edges.values()], lanes };
}

export function changeText(status: ChangeRecord["status"] | "clean", uncommitted: boolean): string {
  const base = status === "A" ? "新增" : status === "M" ? "修改" : status === "D" ? "删除" : status === "R" ? "重命名" : status === "?" ? "未跟踪" : "未变";
  return uncommitted && status !== "?" ? `${base}·未提交` : base;
}

export function kindText(kind: SymbolRecord["kind"]): string {
  return kind === "class" ? "类" : kind === "method" ? "方法" : "函数";
}
