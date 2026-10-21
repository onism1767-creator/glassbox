import path from "node:path";
import { parse, grammarFor, unquote, type Node } from "./parser.ts";
import type { FileRecord, ImportRecord, FileEdge } from "./types.ts";

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

const PY_SUFFIXES = [".py", "/__init__.py"];
const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const JS_INDEXES = JS_EXTENSIONS.map((ext) => "/index" + ext);

function join(...parts: string[]): string {
  const joined = path.posix.normalize(path.posix.join(...parts));
  return joined === "." ? "" : joined.replace(/^\.\//, "");
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

function nodes(list: (Node | null)[]): Node[] {
  return list.filter((n): n is Node => n !== null);
}

async function pythonImports(file: string, source: string, ctx: ImportContext): Promise<ImportRecord[]> {
  const tree = await parse("python", source);
  if (!tree) return [];
  const records: ImportRecord[] = [];
  for (const node of nodes(tree.rootNode.descendantsOfType(["import_statement", "import_from_statement"]))) {
    if (node.type === "import_statement") {
      for (const child of nodes(node.namedChildren)) {
        const nameNode = child.type === "aliased_import" ? child.childForFieldName("name") : child;
        if (!nameNode || nameNode.type !== "dotted_name") continue;
        const spec = nameNode.text;
        records.push({ from: file, spec, line: lineOf(node), level: 0, ...resolvePythonModule(spec, 0, file, ctx) });
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
    const names = nodes(node.childrenForFieldName("name")).map((n) => (n.type === "aliased_import" ? n.childForFieldName("name")?.text ?? "" : n.text)).filter(Boolean);
    const base = resolvePythonModule(spec, level, file, ctx);
    let anyNameResolved = false;
    for (const name of names) {
      const sub = resolvePythonModule(spec ? `${spec}.${name}` : name, level, file, ctx);
      if (sub.status === "resolved" && sub.resolved !== base.resolved) {
        anyNameResolved = true;
        records.push({ from: file, spec: spec ? `${spec}.${name}` : `${".".repeat(level)}${name}`, line: lineOf(node), level, ...sub });
      }
    }
    if (!anyNameResolved || base.status === "resolved") {
      records.push({ from: file, spec: `${".".repeat(level)}${spec}`, line: lineOf(node), level, ...base });
    }
  }
  return records;
}

async function jsImports(file: string, source: string, grammar: "javascript" | "typescript" | "tsx", ctx: ImportContext): Promise<ImportRecord[]> {
  const tree = await parse(grammar, source);
  if (!tree) return [];
  const records: ImportRecord[] = [];
  const add = (spec: string, node: Node): void => {
    records.push({ from: file, spec, line: lineOf(node), level: 0, ...resolveJsSpec(spec, file, ctx) });
  };
  for (const node of nodes(tree.rootNode.descendantsOfType(["import_statement", "export_statement", "call_expression"]))) {
    if (node.type === "import_statement" || node.type === "export_statement") {
      const sourceNode = node.childForFieldName("source");
      if (sourceNode) add(unquote(sourceNode.text), node);
      continue;
    }
    const fn = node.childForFieldName("function");
    const args = node.childForFieldName("arguments");
    if (!fn || !args) continue;
    if (fn.type !== "identifier" && fn.type !== "import") continue;
    if (fn.type === "identifier" && fn.text !== "require") continue;
    const first = nodes(args.namedChildren)[0];
    if (first && (first.type === "string" || first.type === "template_string")) add(unquote(first.text), node);
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
      const records = grammar === "python" ? await pythonImports(f.path, source, ctx) : await jsImports(f.path, source, grammar, ctx);
      all.push(...records);
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
