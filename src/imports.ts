import path from "node:path";
import { parse, grammarFor, unquote, type Node, type GrammarName } from "./parser.ts";
import type { FileRecord, ImportRecord, FileEdge, ImportedName } from "./types.ts";

export interface ImportContext {
  /** 索引内全部文件的相对路径。 */
  known: Set<string>;
  /** Python 绝对导入的根目录（相对仓库，"." 表示根）。 */
  pythonRoots: string[];
  /** 根目录下存在的 Python 顶层包或模块名，用于区分「项目内未解析」与「外部依赖」。 */
  pythonTopLevel: Set<string>;
  /** tsconfig 的 baseUrl 与 paths。 */
  tsPaths: { baseUrl: string; patterns: { prefix: string; targets: string[] }[] } | null;
}

/** 解析前的 import 语句：只记语法，不做文件解析，所以可以按文件缓存。 */
export interface RawImport {
  spec: string;
  line: number;
  level: number;
  names: ImportedName[];
  kind: "python" | "js";
  /** Python 的 from 语句：spec 是模块，names 是导入的名字；import 语句：names 为单个 module 别名。 */
  fromStatement: boolean;
}

const PY_SUFFIXES = [".py", "/__init__.py"];
const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const JS_INDEXES = JS_EXTENSIONS.map((ext) => "/index" + ext);

function join(...parts: string[]): string {
  const joined = path.posix.normalize(path.posix.join(...parts));
  return joined === "." ? "" : joined.replace(/^\.\//, "");
}

function nodes(list: (Node | null)[]): Node[] {
  return list.filter((n): n is Node => n !== null);
}

export function detectPythonRoots(files: FileRecord[], configured?: string[]): string[] {
  if (configured && configured.length) return configured;
  const roots = ["."];
  if (files.some((f) => f.path.startsWith("src/") && f.language === "python")) roots.push("src");
  return roots;
}

export function pythonTopLevelNames(files: FileRecord[], roots: string[]): Set<string> {
  const names = new Set<string>();
  for (const f of files) {
    if (f.language !== "python") continue;
    for (const root of roots) {
      const prefix = root === "." ? "" : root.replace(/\/+$/, "") + "/";
      if (prefix && !f.path.startsWith(prefix)) continue;
      const rel = f.path.slice(prefix.length);
      const top = rel.split("/")[0];
      if (!top) continue;
      names.add(top.endsWith(".py") ? top.slice(0, -3) : top);
    }
  }
  return names;
}

export function readTsPaths(contents: Map<string, string>): ImportContext["tsPaths"] {
  const raw = contents.get("tsconfig.json");
  if (!raw) return null;
  try {
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1").replace(/,\s*([}\]])/g, "$1");
    const json = JSON.parse(stripped) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
    const baseUrl = json.compilerOptions?.baseUrl ?? ".";
    const patterns = Object.entries(json.compilerOptions?.paths ?? {}).map(([key, targets]) => ({
      prefix: key.replace(/\*$/, ""),
      targets: targets.map((t) => t.replace(/\*$/, "")),
    }));
    return { baseUrl, patterns };
  } catch {
    return null;
  }
}

function resolvePythonModule(spec: string, level: number, from: string, ctx: ImportContext): { resolved?: string; status: ImportRecord["status"]; reason?: string } {
  const segments = spec ? spec.split(".") : [];
  const bases: string[] = [];
  if (level > 0) {
    let dir = path.posix.dirname(from);
    for (let i = 1; i < level; i++) dir = path.posix.dirname(dir);
    bases.push(join(dir, ...segments));
  } else {
    for (const root of ctx.pythonRoots) bases.push(join(root === "." ? "" : root, ...segments));
  }
  for (const base of bases) {
    for (const suffix of PY_SUFFIXES) {
      const candidate = base + suffix;
      if (ctx.known.has(candidate)) return { resolved: candidate, status: "resolved" };
    }
  }
  const top = level > 0 ? "" : segments[0] ?? "";
  if (level > 0 || (top && ctx.pythonTopLevel.has(top))) return { status: "unresolved", reason: "项目内找不到对应文件" };
  return { status: "external" };
}

function resolveJsSpec(spec: string, from: string, ctx: ImportContext): { resolved?: string; status: ImportRecord["status"]; reason?: string } {
  const tryBase = (base: string): string | undefined => {
    const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
    const candidates = [base, ...JS_EXTENSIONS.map((e) => stripped + e), ...JS_INDEXES.map((e) => base + e), ...JS_INDEXES.map((e) => stripped + e)];
    return candidates.find((c) => ctx.known.has(c));
  };
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const base = spec.startsWith("/") ? spec.slice(1) : join(path.posix.dirname(from), spec);
    const hit = tryBase(base);
    return hit ? { resolved: hit, status: "resolved" } : { status: "unresolved", reason: "相对路径找不到文件" };
  }
  if (ctx.tsPaths) {
    for (const { prefix, targets } of ctx.tsPaths.patterns) {
      if (!spec.startsWith(prefix)) continue;
      const rest = spec.slice(prefix.length);
      for (const target of targets) {
        const hit = tryBase(join(ctx.tsPaths.baseUrl, target + rest));
        if (hit) return { resolved: hit, status: "resolved" };
      }
    }
    const viaBase = tryBase(join(ctx.tsPaths.baseUrl, spec));
    if (viaBase) return { resolved: viaBase, status: "resolved" };
  }
  return { status: "external" };
}

function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

function pythonRaw(root: Node): RawImport[] {
  const out: RawImport[] = [];
  for (const node of nodes(root.descendantsOfType(["import_statement", "import_from_statement"]))) {
    if (node.type === "import_statement") {
      for (const child of nodes(node.namedChildren)) {
        const nameNode = child.type === "aliased_import" ? child.childForFieldName("name") : child;
        if (!nameNode || nameNode.type !== "dotted_name") continue;
        const aliasNode = child.type === "aliased_import" ? child.childForFieldName("alias") : null;
        out.push({ spec: nameNode.text, line: lineOf(node), level: 0, names: [{ name: "", alias: aliasNode ? aliasNode.text : nameNode.text, kind: "module" }], kind: "python", fromStatement: false });
      }
      continue;
    }
    const moduleNode = node.childForFieldName("module_name");
    if (!moduleNode) continue;
    let level = 0;
    let spec = "";
    if (moduleNode.type === "relative_import") {
      const prefix = nodes(moduleNode.namedChildren).find((c) => c.type === "import_prefix");
      level = prefix ? prefix.text.length : 0;
      const dotted = nodes(moduleNode.namedChildren).find((c) => c.type === "dotted_name");
      spec = dotted ? dotted.text : "";
    } else {
      spec = moduleNode.text;
    }
    const names: ImportedName[] = nodes(node.childrenForFieldName("name")).map((n) => {
      const name = n.type === "aliased_import" ? n.childForFieldName("name")?.text ?? "" : n.text;
      const alias = n.type === "aliased_import" ? n.childForFieldName("alias")?.text ?? name : name;
      return { name, alias, kind: "named" as const };
    }).filter((x) => x.name);
    out.push({ spec, line: lineOf(node), level, names, kind: "python", fromStatement: true });
  }
  return out;
}

/** `import d, { a, b as c } from "x"` / `import * as ns from "x"` 带进来的名字。 */
function jsImportedNames(node: Node): ImportedName[] {
  const names: ImportedName[] = [];
  const clause = nodes(node.namedChildren).find((c) => c.type === "import_clause");
  if (!clause) return names;
  for (const child of nodes(clause.namedChildren)) {
    if (child.type === "identifier") names.push({ name: "default", alias: child.text, kind: "default" });
    else if (child.type === "namespace_import") {
      const id = nodes(child.namedChildren).find((c) => c.type === "identifier");
      if (id) names.push({ name: "", alias: id.text, kind: "namespace" });
    } else if (child.type === "named_imports") {
      for (const spec of nodes(child.namedChildren)) {
        if (spec.type !== "import_specifier") continue;
        const name = spec.childForFieldName("name")?.text ?? "";
        const alias = spec.childForFieldName("alias")?.text ?? name;
        if (name) names.push({ name, alias, kind: "named" });
      }
    }
  }
  return names;
}

function jsRaw(root: Node): RawImport[] {
  const out: RawImport[] = [];
  for (const node of nodes(root.descendantsOfType(["import_statement", "export_statement", "call_expression"]))) {
    if (node.type === "import_statement" || node.type === "export_statement") {
      const sourceNode = node.childForFieldName("source");
      if (sourceNode) out.push({ spec: unquote(sourceNode.text), line: lineOf(node), level: 0, names: node.type === "import_statement" ? jsImportedNames(node) : [], kind: "js", fromStatement: true });
      continue;
    }
    const fn = node.childForFieldName("function");
    const args = node.childForFieldName("arguments");
    if (!fn || !args) continue;
    if (fn.type !== "identifier" && fn.type !== "import") continue;
    if (fn.type === "identifier" && fn.text !== "require") continue;
    const first = nodes(args.namedChildren)[0];
    if (first && (first.type === "string" || first.type === "template_string")) out.push({ spec: unquote(first.text), line: lineOf(node), level: 0, names: [], kind: "js", fromStatement: true });
  }
  return out;
}

/** 单个文件的 import 语句，按语法提取，不解析目标。 */
export async function extractRawImports(file: string, source: string, grammar: GrammarName): Promise<RawImport[]> {
  const tree = await parse(grammar, source);
  if (!tree) return [];
  return grammar === "python" ? pythonRaw(tree.rootNode) : jsRaw(tree.rootNode);
}

/** 把一个文件的 raw import 解析到项目内文件。 */
export function resolveImports(file: string, raw: RawImport[], ctx: ImportContext): ImportRecord[] {
  const records: ImportRecord[] = [];
  for (const r of raw) {
    if (r.kind === "js") {
      records.push({ from: file, spec: r.spec, line: r.line, level: 0, names: r.names, ...resolveJsSpec(r.spec, file, ctx) });
      continue;
    }
    if (!r.fromStatement) {
      records.push({ from: file, spec: r.spec, line: r.line, level: 0, names: r.names, ...resolvePythonModule(r.spec, 0, file, ctx) });
      continue;
    }
    const base = resolvePythonModule(r.spec, r.level, file, ctx);
    const remaining: ImportedName[] = [];
    for (const n of r.names) {
      const sub = resolvePythonModule(r.spec ? `${r.spec}.${n.name}` : n.name, r.level, file, ctx);
      if (sub.status === "resolved" && sub.resolved !== base.resolved) {
        records.push({ from: file, spec: r.spec ? `${r.spec}.${n.name}` : `${".".repeat(r.level)}${n.name}`, line: r.line, level: r.level, names: [{ name: "", alias: n.alias, kind: "module" }], ...sub });
      } else {
        remaining.push(n);
      }
    }
    if (remaining.length || base.status === "resolved" || !r.names.length) {
      records.push({ from: file, spec: `${".".repeat(r.level)}${r.spec}`, line: r.line, level: r.level, names: remaining, ...base });
    }
  }
  return records;
}

export async function extractImports(files: FileRecord[], contents: Map<string, string>, ctx: ImportContext): Promise<ImportRecord[]> {
  const all: ImportRecord[] = [];
  for (const f of files) {
    const grammar = grammarFor(f.language);
    const source = contents.get(f.path);
    if (!grammar || source === undefined) continue;
    try {
      all.push(...resolveImports(f.path, await extractRawImports(f.path, source, grammar), ctx));
    } catch (error) {
      all.push({ from: f.path, spec: "", line: 1, level: 0, status: "unresolved", reason: `解析失败: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return all;
}

export function buildFileEdges(records: ImportRecord[]): FileEdge[] {
  const edges = new Map<string, FileEdge>();
  for (const r of records) {
    if (r.status !== "resolved" || !r.resolved || r.resolved === r.from) continue;
    const key = `${r.from}\u0000${r.resolved}`;
    let edge = edges.get(key);
    if (!edge) {
      edge = { from: r.from, to: r.resolved, kind: "import", evidence: [] };
      edges.set(key, edge);
    }
    if (!edge.evidence.some((e) => e.line === r.line)) edge.evidence.push({ path: r.from, line: r.line, note: r.spec });
  }
  return [...edges.values()];
}
