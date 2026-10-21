import { parse as parseYaml } from "yaml";
import { parse, unquote, type Node } from "./parser.ts";
import type { Overlay, GuardTestRef, WordsFromYaml } from "./config.ts";
import type { Evidence, FileEdge, FileRecord, LayerRules, Violation, AllowedEdge } from "./types.ts";

function nodes(list: (Node | null)[]): Node[] {
  return list.filter((n): n is Node => n !== null);
}

/** 顶层目录名；根目录文件记为 "."。 */
export function topDir(p: string): string {
  const i = p.indexOf("/");
  return i < 0 ? "." : p.slice(0, i);
}

/** 文件路径 → Python 点分模块名。 */
export function moduleName(p: string): string {
  return p.replace(/\.pyi?$/, "").replace(/\/__init__$/, "").split("/").join(".");
}

type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal };

/** 只求值字面量：字符串、数字、布尔、None、元组、列表、集合、字典。遇到别的就返回 undefined。 */
function evalLiteral(node: Node): Literal | undefined {
  switch (node.type) {
    case "string": {
      const content = nodes(node.namedChildren).filter((c) => c.type === "string_content").map((c) => c.text).join("");
      return content || unquote(node.text);
    }
    case "integer":
      return Number.parseInt(node.text, 10);
    case "float":
      return Number.parseFloat(node.text);
    case "true":
      return true;
    case "false":
      return false;
    case "none":
      return null;
    case "tuple":
    case "list":
    case "set": {
      const items: Literal[] = [];
      for (const child of nodes(node.namedChildren)) {
        if (child.type === "comment") continue;
        const value = evalLiteral(child);
        if (value === undefined) return undefined;
        items.push(value);
      }
      return items;
    }
    case "dictionary": {
      const out: { [key: string]: Literal } = {};
      for (const pair of nodes(node.namedChildren)) {
        if (pair.type !== "pair") continue;
        const key = pair.childForFieldName("key");
        const value = pair.childForFieldName("value");
        if (!key || !value) return undefined;
        const k = evalLiteral(key);
        const v = evalLiteral(value);
        if (typeof k !== "string" || v === undefined) return undefined;
        out[k] = v;
      }
      return out;
    }
    case "parenthesized_expression": {
      const inner = nodes(node.namedChildren)[0];
      return inner ? evalLiteral(inner) : undefined;
    }
    default:
      return undefined;
  }
}

export interface GuardLiterals {
  layers?: { value: Record<string, number>; evidence: Evidence };
  allowed?: { value: { from: string; to: string }[]; evidence: Evidence };
  problems: string[];
}

/** 从守卫测试源码读 LAYER 与 ALLOWED 这类模块级字面量赋值，不执行代码。 */
export async function readGuardLiterals(file: string, source: string, ref: GuardTestRef): Promise<GuardLiterals> {
  const layerVar = ref.layer_var ?? "LAYER";
  const allowedVar = ref.allowed_var ?? "ALLOWED";
  const out: GuardLiterals = { problems: [] };
  const tree = await parse("python", source);
  if (!tree) {
    out.problems.push(`无法解析 ${file}`);
    return out;
  }
  for (const stmt of nodes(tree.rootNode.namedChildren)) {
    if (stmt.type !== "expression_statement") continue;
    const assignment = nodes(stmt.namedChildren).find((c) => c.type === "assignment");
    if (!assignment) continue;
    const left = assignment.childForFieldName("left");
    const right = assignment.childForFieldName("right");
    if (!left || !right || left.type !== "identifier") continue;
    const line = assignment.startPosition.row + 1;
    if (left.text === layerVar) {
      const value = evalLiteral(right);
      if (value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "number")) {
        out.layers = { value: value as Record<string, number>, evidence: { path: file, line, note: `${layerVar} = …` } };
      } else {
        out.problems.push(`${file}:${line} ${layerVar} 不是「包名 → 整数」字典`);
      }
    } else if (left.text === allowedVar) {
      const value = evalLiteral(right);
      if (Array.isArray(value) && value.every((v) => Array.isArray(v) && v.length === 2 && v.every((s) => typeof s === "string"))) {
        out.allowed = {
          value: (value as string[][]).map(([from, to]) => ({ from: from ?? "", to: to ?? "" })),
          evidence: { path: file, line, note: `${allowedVar} = …` },
        };
      } else {
        out.problems.push(`${file}:${line} ${allowedVar} 不是「(包, 模块)」二元组集合`);
      }
    }
  }
  return out;
}

export interface RuleSources {
  overlay: Overlay;
  contents: Map<string, string>;
}

/** 合成规则：守卫测试（T0）优先于 overlay 手写（T2）。 */
export async function buildRules({ overlay, contents }: RuleSources): Promise<{ rules: LayerRules; problems: string[] }> {
  const rules: LayerRules = { layers: {}, allowed: [], isolated: [], forbiddenWords: [], provenance: [] };
  const problems: string[] = [];
  const ref = overlay.layers?.from_guard_test;
  if (ref) {
    const source = contents.get(ref.file);
    if (source === undefined) {
      problems.push(`守卫测试文件不在索引内: ${ref.file}`);
    } else {
      const literals = await readGuardLiterals(ref.file, source, ref);
      problems.push(...literals.problems);
      if (literals.layers) {
        rules.layers = literals.layers.value;
        rules.provenance.push({ what: "layers", tier: "T0", evidence: literals.layers.evidence });
      }
      if (literals.allowed) {
        rules.allowed = literals.allowed.value.map((a) => ({ ...a, source: literals.allowed?.evidence }));
        rules.provenance.push({ what: "allowed", tier: "T0", evidence: literals.allowed.evidence });
      }
    }
  }
  if (!Object.keys(rules.layers).length && overlay.layers?.manual) {
    rules.layers = overlay.layers.manual;
    rules.provenance.push({ what: "layers", tier: "T2", evidence: { path: ".workbench/overlay.yaml", note: "layers.manual" } });
  }
  for (const a of overlay.layers?.allowed ?? []) {
    if (!rules.allowed.some((x) => x.from === a.from && x.to === a.to)) {
      rules.allowed.push({ from: a.from, to: a.to, source: { path: ".workbench/overlay.yaml", note: a.note ?? "layers.allowed" } });
      rules.provenance.push({ what: `allowed ${a.from} → ${a.to}`, tier: "T2" });
    }
  }
  for (const pkg of overlay.isolated_packages ?? []) {
    rules.isolated.push({ pkg, source: { path: ".workbench/overlay.yaml", note: "isolated_packages" } });
  }
  for (const fw of overlay.forbidden_words ?? []) {
    const words = new Set((fw.words ?? []).map((w) => w.toLowerCase()));
    let source: Evidence = { path: ".workbench/overlay.yaml", note: fw.source ?? "forbidden_words" };
    let tier: "T0" | "T2" = "T2";
    if (fw.words_from) {
      const derived = wordsFromYaml(fw.words_from, contents);
      if (derived.problem) problems.push(derived.problem);
      for (const w of derived.words) words.add(w);
      if (derived.words.length) {
        source = { path: fw.words_from.file, note: fw.source ?? `禁用词名单来自 ${fw.words_from.file}` };
        tier = "T0";
      }
    }
    rules.forbiddenWords.push({ dirs: fw.dirs, words: [...words].sort(), match: fw.match ?? "substring", source });
    rules.provenance.push({ what: `forbidden words in ${fw.dirs.join(", ")}`, tier, evidence: source });
  }
  return { rules, problems };
}

function wordsFromYaml(spec: WordsFromYaml, contents: Map<string, string>): { words: string[]; problem?: string } {
  const raw = contents.get(spec.file);
  if (raw === undefined) return { words: [], problem: `禁用词来源文件不在索引内: ${spec.file}` };
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (error) {
    return { words: [], problem: `无法解析 ${spec.file}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const list = doc && typeof doc === "object" ? (doc as Record<string, unknown>)[spec.list] : undefined;
  if (!Array.isArray(list)) return { words: [], problem: `${spec.file} 里没有列表 ${spec.list}` };
  const words = new Set<string>();
  const exclude = new Set((spec.split?.exclude ?? []).map((w) => w.toLowerCase()));
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    for (const field of spec.fields) {
      const value = record[field];
      if (typeof value === "string" && value) words.add(value.toLowerCase());
    }
    if (spec.split) {
      const value = record[spec.split.field];
      if (typeof value === "string") {
        for (const token of value.toLowerCase().split(spec.split.sep)) {
          if (token && !exclude.has(token)) words.add(token);
        }
      }
    }
  }
  return { words: [...words].sort() };
}

export interface RuleCheck {
  violations: Violation[];
  allowed: AllowedEdge[];
  layeredEdges: number;
}

export function checkRules(edges: FileEdge[], files: FileRecord[], contents: Map<string, string>, rules: LayerRules): RuleCheck {
  const violations: Violation[] = [];
  const allowed: AllowedEdge[] = [];
  let layeredEdges = 0;
  const isolated = new Set(rules.isolated.map((i) => i.pkg));
  for (const edge of edges) {
    const fromPkg = topDir(edge.from);
    const toPkg = topDir(edge.to);
    if (fromPkg === toPkg) continue;
    const fromLevel = rules.layers[fromPkg];
    const toLevel = rules.layers[toPkg];
    const toModule = moduleName(edge.to);
    if (isolated.has(fromPkg) && (toLevel !== undefined || rules.layers[toPkg] !== undefined || toPkg in rules.layers)) {
      for (const ev of edge.evidence) {
        violations.push({ rule: "isolated-package", from: edge.from, to: edge.to, evidence: ev, message: `${fromPkg} 应零项目内依赖，却 import 了 ${toModule}` });
      }
      continue;
    }
    if (fromLevel === undefined || toLevel === undefined) continue;
    layeredEdges++;
    if (toLevel <= fromLevel) continue;
    const exception = rules.allowed.find((a) => a.from === fromPkg && (toModule === a.to || toModule.startsWith(a.to + ".")));
    for (const ev of edge.evidence) {
      if (exception) {
        allowed.push({ from: edge.from, to: edge.to, evidence: ev, allowedBy: exception.source });
      } else {
        violations.push({ rule: "layer-direction", from: edge.from, to: edge.to, evidence: ev, message: `${fromPkg}（L${fromLevel}）import 了上层 ${toModule}（L${toLevel}）` });
      }
    }
  }
  for (const fw of rules.forbiddenWords) {
    if (!fw.words.length) continue;
    const alternation = fw.words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const rx = fw.match === "word" ? new RegExp(`\\b(${alternation})\\b`, "i") : new RegExp(`(${alternation})`, "i");
    for (const f of files) {
      if (f.language !== "python" && f.language !== "typescript" && f.language !== "tsx" && f.language !== "javascript") continue;
      if (!fw.dirs.some((d) => f.path === d || f.path.startsWith(d.replace(/\/+$/, "") + "/"))) continue;
      const source = contents.get(f.path);
      if (source === undefined) continue;
      const lines = source.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const m = rx.exec(lines[i] ?? "");
        if (m) violations.push({ rule: "forbidden-word", from: f.path, evidence: { path: f.path, line: i + 1, note: m[0] }, message: `${f.path}:${i + 1} 出现禁用词「${m[0]}」` });
      }
    }
  }
  return { violations, allowed, layeredEdges };
}
