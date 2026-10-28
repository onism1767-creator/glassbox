/**
 * 人话标注（T2 声明）：目录、文件、函数或类的中文名和一句话职责，由人或 AI 写，
 * 每条绑定到画布上一个真实节点，并记下写标注时该节点的内容哈希。节点变了标注自动标"过时"，
 * 节点没了标"没对象"。写入前逐条校验：节点得存在、依据得在节点里、哈希得等于现在的。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Evidence, FileEdge, FileRecord, SymbolRecord, Tier } from "./types.ts";
import { topDir } from "./rules.ts";

export const ANNOTATIONS_FILE = "annotations.yaml";

export interface Annotation {
  /** 画布节点 id：dir:engine、file:engine/models.py、sym:engine/models.py::Model.save */
  node: string;
  /** 人话名字，画布上显示成「名字（术语）」。 */
  name: string;
  /** 一句话职责。 */
  role: string;
  /** 依据：标注是看了哪几行写的；必须落在这个节点里。 */
  basis: Evidence[];
  /** 写标注时节点的内容哈希。 */
  hash: string;
  author: string;
  at: string;
}

export type AnnotationStatus = "fresh" | "stale" | "orphan";

export interface AnnotationView extends Annotation {
  status: AnnotationStatus;
  /** 节点现在的哈希（stale 时和 hash 不同）。 */
  currentHash?: string;
  /** 哈希是按什么算的，给人看。 */
  hashBasis?: string;
}

export interface AnnotationSnapshot {
  source: string;
  tier: Tier;
  items: AnnotationView[];
  summary: { total: number; fresh: number; stale: number; orphan: number; todoDirs: number; todoFiles: number };
  howTo: string;
}

/** 画布节点的世界：算哈希和校验用。 */
export interface NodeWorld {
  files: FileRecord[];
  symbols: SymbolRecord[];
  edges: FileEdge[];
  layers: Record<string, number>;
}

export interface NodeInfo {
  node: string;
  kind: "dir" | "file" | "symbol";
  hash: string;
  hashBasis: string;
  path?: string;
  dir?: string;
  symbol?: SymbolRecord;
}

export function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

const CODE_LANGUAGES = new Set(["python", "typescript", "tsx", "javascript"]);

/** 画布上有哪些节点、它们现在的哈希。目录按"里面有哪些文件"算（增删改名才算变），文件按内容，函数或类按自己的源码。 */
export function nodeTable(world: NodeWorld): Map<string, NodeInfo> {
  const table = new Map<string, NodeInfo>();
  const byTop = new Map<string, string[]>();
  for (const f of world.files) {
    const top = topDir(f.path);
    byTop.set(top, [...(byTop.get(top) ?? []), f.path]);
    table.set(`file:${f.path}`, { node: `file:${f.path}`, kind: "file", hash: f.hash, hashBasis: "文件内容", path: f.path, dir: top });
  }
  for (const [dir, paths] of byTop) {
    table.set(`dir:${dir}`, { node: `dir:${dir}`, kind: "dir", hash: sha1(paths.sort().join("\n")), hashBasis: "目录里的文件清单（文件增删改名才算变，内容变不算）", dir });
  }
  const fileHash = new Map(world.files.map((f) => [f.path, f.hash]));
  for (const s of world.symbols) {
    const own = s.hash;
    table.set(`sym:${s.id}`, {
      node: `sym:${s.id}`,
      kind: "symbol",
      hash: own ?? fileHash.get(s.path) ?? "",
      hashBasis: own ? "这个函数或类自己的源码" : "所在文件的内容（旧索引没有符号哈希）",
      path: s.path,
      dir: topDir(s.path),
      symbol: s,
    });
  }
  return table;
}

export function annotationsPath(stateDir: string): string {
  return path.join(stateDir, ANNOTATIONS_FILE);
}

export function readAnnotations(stateDir: string): { items: Annotation[]; problems: string[] } {
  const file = annotationsPath(stateDir);
  if (!fs.existsSync(file)) return { items: [], problems: [] };
  try {
    const raw = parseYaml(fs.readFileSync(file, "utf8")) as { version?: number; items?: unknown[] } | null;
    const list = Array.isArray(raw?.items) ? raw.items : [];
    const items: Annotation[] = [];
    const problems: string[] = [];
    list.forEach((x, i) => {
      const a = x as Partial<Annotation>;
      if (typeof a.node === "string" && typeof a.name === "string" && typeof a.role === "string" && typeof a.hash === "string") {
        items.push({ node: a.node, name: a.name, role: a.role, basis: Array.isArray(a.basis) ? (a.basis as Evidence[]) : [], hash: a.hash, author: typeof a.author === "string" ? a.author : "?", at: typeof a.at === "string" ? a.at : "" });
      } else problems.push(`第 ${i + 1} 条缺字段，跳过`);
    });
    return { items, problems };
  } catch (error) {
    return { items: [], problems: [`${ANNOTATIONS_FILE} 读不了：${error instanceof Error ? error.message : String(error)}`] };
  }
}

export function writeAnnotations(stateDir: string, items: Annotation[]): string {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = annotationsPath(stateDir);
  const sorted = [...items].sort((a, b) => a.node.localeCompare(b.node));
  const text = "# glassbox 人话标注（T2 声明）。每条绑定画布上一个节点，hash 是写时节点的内容哈希；用 glassbox annotate set 写，别手改 hash。\n" + stringifyYaml({ version: 1, items: sorted });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

export const HOW_TO = "让 AI 跑 glassbox annotate todo <仓库> 看还有谁没标、拿到节点哈希，读源码后写 JSON，再 glassbox annotate set <仓库> --file 批.json；过时的同样重写。";

function isCodeFile(f: FileRecord): boolean {
  return !f.binary && f.size > 0 && CODE_LANGUAGES.has(f.language);
}

export function annotationSnapshot(stateDir: string, world: NodeWorld, rel: (p: string) => string = (p) => p): AnnotationSnapshot {
  const { items, problems } = readAnnotations(stateDir);
  const table = nodeTable(world);
  const views: AnnotationView[] = items.map((a) => {
    const info = table.get(a.node);
    if (!info) return { ...a, status: "orphan" };
    return { ...a, status: info.hash === a.hash ? "fresh" : "stale", currentHash: info.hash, hashBasis: info.hashBasis };
  });
  const fresh = new Set(views.filter((v) => v.status === "fresh").map((v) => v.node));
  const dirs = new Set(world.files.map((f) => topDir(f.path)));
  const todoDirs = [...dirs].filter((d) => !fresh.has(`dir:${d}`)).length;
  const todoFiles = world.files.filter((f) => isCodeFile(f) && !fresh.has(`file:${f.path}`)).length;
  return {
    source: rel(annotationsPath(stateDir)),
    tier: "T2",
    items: views,
    summary: { total: views.length, fresh: fresh.size, stale: views.filter((v) => v.status === "stale").length, orphan: views.filter((v) => v.status === "orphan").length, todoDirs, todoFiles },
    howTo: problems.length ? `${problems.join("；")}。${HOW_TO}` : HOW_TO,
  };
}

export interface TodoItem {
  node: string;
  kind: "dir" | "file" | "symbol";
  /** missing：还没标；stale：标过但代码变了。 */
  why: "missing" | "stale";
  hash: string;
  hashBasis: string;
  dir?: string;
  path?: string;
  layer?: number;
  fileCount?: number;
  files?: string[];
  language?: string;
  size?: number;
  symbols?: { kind: string; qualified: string; startLine: number; endLine: number }[];
  importsOut?: string[];
  importedBy?: number;
  /** 过时的旧标注，重写时可参考。 */
  previous?: { name: string; role: string; at: string };
  /** 文件所在目录已有的标注名（帮 AI 对齐口径）。 */
  dirName?: string;
  symbol?: { kind: string; qualified: string; startLine: number; endLine: number };
}

export interface TodoOptions {
  kind?: "dir" | "file" | "symbol";
  /** 只看这个目录下的文件或符号。 */
  dir?: string;
  /** 只看这个文件里的符号。 */
  file?: string;
  limit?: number;
}

/** 还有谁没标、谁的标注过时了，带上 AI 写标注需要的上下文，按重要性排。 */
export function annotationTodo(world: NodeWorld, existing: Annotation[], options: TodoOptions = {}): TodoItem[] {
  const table = nodeTable(world);
  const byNode = new Map(existing.map((a) => [a.node, a]));
  const state = (node: string): "fresh" | "missing" | "stale" => {
    const a = byNode.get(node);
    if (!a) return "missing";
    return table.get(node)?.hash === a.hash ? "fresh" : "stale";
  };
  const prev = (node: string): TodoItem["previous"] | undefined => {
    const a = byNode.get(node);
    return a ? { name: a.name, role: a.role, at: a.at } : undefined;
  };
  const importedBy = new Map<string, number>();
  const importsOut = new Map<string, Set<string>>();
  for (const e of world.edges) {
    importedBy.set(e.to, (importedBy.get(e.to) ?? 0) + 1);
    importsOut.set(e.from, new Set([...(importsOut.get(e.from) ?? []), e.to]));
  }
  const symbolsByFile = new Map<string, SymbolRecord[]>();
  for (const s of world.symbols) symbolsByFile.set(s.path, [...(symbolsByFile.get(s.path) ?? []), s]);
  const out: TodoItem[] = [];
  const wantDir = (d: string) => !options.dir || d === options.dir;
  if (!options.kind || options.kind === "dir") {
    const byTop = new Map<string, string[]>();
    for (const f of world.files) byTop.set(topDir(f.path), [...(byTop.get(topDir(f.path)) ?? []), f.path]);
    for (const [dir, paths] of [...byTop].sort((a, b) => b[1].length - a[1].length)) {
      if (!wantDir(dir)) continue;
      const node = `dir:${dir}`;
      const st = state(node);
      if (st === "fresh") continue;
      const info = table.get(node)!;
      out.push({
        node, kind: "dir", why: st, hash: info.hash, hashBasis: info.hashBasis, dir,
        ...(world.layers[dir] !== undefined ? { layer: world.layers[dir] } : {}),
        fileCount: paths.length,
        files: paths.sort().slice(0, 30).map((p) => {
          const a = byNode.get(`file:${p}`);
          return a && state(`file:${p}`) === "fresh" ? `${p}（已标：${a.name}）` : p;
        }),
        ...(prev(node) ? { previous: prev(node) } : {}),
      });
    }
  }
  if (!options.kind || options.kind === "file") {
    const files = world.files.filter((f) => isCodeFile(f) && wantDir(topDir(f.path)) && (!options.file || f.path === options.file));
    files.sort((a, b) => (importedBy.get(b.path) ?? 0) - (importedBy.get(a.path) ?? 0) || a.path.localeCompare(b.path));
    for (const f of files) {
      const node = `file:${f.path}`;
      const st = state(node);
      if (st === "fresh") continue;
      const info = table.get(node)!;
      const dirAnn = byNode.get(`dir:${topDir(f.path)}`);
      out.push({
        node, kind: "file", why: st, hash: info.hash, hashBasis: info.hashBasis, path: f.path, dir: topDir(f.path),
        ...(world.layers[topDir(f.path)] !== undefined ? { layer: world.layers[topDir(f.path)] } : {}),
        language: f.language, size: f.size,
        symbols: (symbolsByFile.get(f.path) ?? []).slice(0, 40).map((s) => ({ kind: s.kind, qualified: s.qualified, startLine: s.startLine, endLine: s.endLine })),
        importsOut: [...(importsOut.get(f.path) ?? [])].sort().slice(0, 20),
        importedBy: importedBy.get(f.path) ?? 0,
        ...(dirAnn ? { dirName: dirAnn.name } : {}),
        ...(prev(node) ? { previous: prev(node) } : {}),
      });
    }
  }
  if (options.kind === "symbol") {
    const syms = world.symbols.filter((s) => wantDir(topDir(s.path)) && (!options.file || s.path === options.file));
    for (const s of syms) {
      const node = `sym:${s.id}`;
      const st = state(node);
      if (st === "fresh") continue;
      const info = table.get(node)!;
      out.push({ node, kind: "symbol", why: st, hash: info.hash, hashBasis: info.hashBasis, path: s.path, dir: topDir(s.path), symbol: { kind: s.kind, qualified: s.qualified, startLine: s.startLine, endLine: s.endLine }, ...(prev(node) ? { previous: prev(node) } : {}) });
    }
  }
  return options.limit ? out.slice(0, options.limit) : out;
}

export interface ValidateContext {
  /** 文件有多少行；不知道就返回 undefined，行号只查下限。 */
  lineCount: (p: string) => number | undefined;
  author: string;
  now: string;
}

export interface ValidateResult {
  accepted: Annotation[];
  rejected: { index: number; node?: string; reason: string }[];
}

const NAME_MAX = 40;
const ROLE_MAX = 200;

/** 逐条校验：节点存在、名字和职责像样、依据在节点里且行号有效、哈希等于现在的。不通过整条退回，说明原因。 */
export function validateAnnotations(raw: unknown, table: Map<string, NodeInfo>, ctx: ValidateContext): ValidateResult {
  const list: unknown[] = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items) ? ((raw as { items: unknown[] }).items) : [];
  const accepted: Annotation[] = [];
  const rejected: ValidateResult["rejected"] = [];
  const seen = new Set<string>();
  if (!Array.isArray(raw) && !list.length) rejected.push({ index: 0, reason: "要一个 JSON 数组，或 { items: [...] }" });
  list.forEach((x, index) => {
    const a = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const node = typeof a["node"] === "string" ? a["node"].trim() : "";
    const bad = (reason: string) => rejected.push({ index, ...(node ? { node } : {}), reason });
    if (!node) return bad("缺 node（画布节点 id，形如 dir:engine、file:engine/models.py、sym:engine/models.py::Model）");
    const info = table.get(node);
    if (!info) return bad(`节点不存在：${node}（用 glassbox annotate todo 看有哪些）`);
    if (seen.has(node)) return bad(`同一批里重复：${node}`);
    const name = typeof a["name"] === "string" ? a["name"].trim() : "";
    const role = typeof a["role"] === "string" ? a["role"].trim() : "";
    if (!name) return bad("缺 name（人话名字）");
    if (name.length > NAME_MAX) return bad(`name 太长（${name.length} 字，最多 ${NAME_MAX}）`);
    if (!role) return bad("缺 role（一句话职责）");
    if (role.length > ROLE_MAX) return bad(`role 太长（${role.length} 字，最多 ${ROLE_MAX}）`);
    if (/已验证|verified/i.test(name + role)) return bad("标注里不能写「已验证」，那个词只有检验器能写");
    const basisRaw = Array.isArray(a["basis"]) ? (a["basis"] as unknown[]) : [];
    if (!basisRaw.length) return bad("缺 basis（至少一条依据：{ path, line }，说明是看了哪里写的）");
    const basis: Evidence[] = [];
    for (const b of basisRaw) {
      const e = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
      const p = typeof e["path"] === "string" ? e["path"].replace(/\\/g, "/").replace(/^\.\//, "") : "";
      const line = e["line"] === undefined ? undefined : Number(e["line"]);
      if (!p) return bad("依据缺 path");
      const fileInfo = table.get(`file:${p}`);
      if (!fileInfo) return bad(`依据的文件不在索引里：${p}`);
      if (line !== undefined && (!Number.isInteger(line) || line < 1)) return bad(`依据的行号不合法：${p}:${String(e["line"])}`);
      const count = ctx.lineCount(p);
      if (line !== undefined && count !== undefined && line > count) return bad(`依据的行号超出文件：${p} 只有 ${count} 行，给的是 ${line}`);
      if (info.kind === "file" && p !== info.path) return bad(`依据不在这个文件里：${p}（节点是 ${info.path}）`);
      if (info.kind === "dir" && topDir(p) !== info.dir) return bad(`依据不在这个目录里：${p}（节点是 ${info.dir}）`);
      if (info.kind === "symbol") {
        const s = info.symbol!;
        if (p !== s.path) return bad(`依据不在这个函数或类所在的文件里：${p}（节点在 ${s.path}）`);
        if (line === undefined) return bad("函数或类的依据要给行号");
        if (line < s.startLine || line > s.endLine) return bad(`依据的行号不在这个函数或类里：${p}:${line}（它在第 ${s.startLine}–${s.endLine} 行）`);
      }
      basis.push({ path: p, ...(line !== undefined ? { line } : {}), ...(typeof e["note"] === "string" && e["note"] ? { note: e["note"].slice(0, 120) } : {}) });
    }
    const hash = typeof a["hash"] === "string" ? a["hash"].trim() : "";
    if (!hash) return bad("缺 hash（glassbox annotate todo 给的节点哈希）");
    if (hash !== info.hash) return bad(`过期：你读的版本和现在不一样（你给的 ${hash.slice(0, 12)}，现在 ${info.hash.slice(0, 12)}；${info.hashBasis}）。重新看一眼再写`);
    seen.add(node);
    accepted.push({ node, name, role, basis, hash, author: typeof a["author"] === "string" && a["author"] ? a["author"].slice(0, 40) : ctx.author, at: ctx.now });
  });
  return { accepted, rejected };
}

export interface ApplyResult extends ValidateResult {
  file: string;
  total: number;
}

/** 校验后把收下的写进 annotations.yaml（同一节点覆盖旧的）。 */
export function applyAnnotations(stateDir: string, world: NodeWorld, raw: unknown, ctx: ValidateContext): ApplyResult {
  const table = nodeTable(world);
  const result = validateAnnotations(raw, table, ctx);
  const { items } = readAnnotations(stateDir);
  const byNode = new Map(items.map((a) => [a.node, a]));
  for (const a of result.accepted) byNode.set(a.node, a);
  const all = [...byNode.values()];
  const file = result.accepted.length ? writeAnnotations(stateDir, all) : annotationsPath(stateDir);
  return { ...result, file, total: all.length };
}

/** 从仓库数行数（校验行号用），读不到就不查上限。 */
export function lineCounter(root: string): (p: string) => number | undefined {
  const memo = new Map<string, number | undefined>();
  return (p) => {
    if (memo.has(p)) return memo.get(p);
    let n: number | undefined;
    try {
      const full = path.join(root, p);
      const st = fs.statSync(full);
      if (st.size <= 2 * 1024 * 1024) n = fs.readFileSync(full, "utf8").split("\n").length;
    } catch {
      n = undefined;
    }
    memo.set(p, n);
    return n;
  };
}
