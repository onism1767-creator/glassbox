import { parse, type Node, type GrammarName } from "./parser.ts";
import { enclosingSymbol, moduleSymbolId } from "./symbols.ts";
import type { ImportRecord, SymbolRecord, CallEdge, UnresolvedCall, UnresolvedKind, CallResolution } from "./types.ts";

function nodes(list: (Node | null)[]): Node[] {
  return list.filter((n): n is Node => n !== null);
}

export interface CallExtraction {
  edges: CallEdge[];
  unresolved: UnresolvedCall[];
  sites: number;
}

/** 解析前的调用点：只有语法信息，可按文件缓存。 */
export interface CallSite {
  line: number;
  /** 最后一段名字的起始列（0 起）。 */
  col: number;
  parts: string[] | null;
  callee: string;
  kind: "python" | "js";
}

const PYTHON_BUILTINS = new Set("abs all any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip __import__ Exception ValueError TypeError KeyError IndexError RuntimeError NotImplementedError AttributeError StopIteration OSError IOError FileNotFoundError PermissionError TimeoutError ConnectionError AssertionError ImportError LookupError ZeroDivisionError OverflowError UnicodeDecodeError UnicodeEncodeError".split(" "));
const JS_BUILTINS = new Set("Array Object String Number Boolean Symbol BigInt Map Set WeakMap WeakSet Promise Date RegExp Error TypeError RangeError SyntaxError JSON Math Reflect Proxy Intl parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI setTimeout setInterval clearTimeout clearInterval queueMicrotask structuredClone fetch console require Buffer URL URLSearchParams TextEncoder TextDecoder AbortController Headers Request Response".split(" "));

interface NameTable {
  local: Map<string, SymbolRecord>;
  methods: Map<string, Map<string, SymbolRecord>>;
  named: Map<string, { file: string; name: string }>;
  modules: Map<string, string>;
  external: Map<string, string>;
}

type Resolved = { symbol: SymbolRecord; resolution: CallResolution } | { kind: UnresolvedKind; reason: string };

class Resolver {
  private readonly byFile = new Map<string, SymbolRecord[]>();
  private readonly tables = new Map<string, NameTable>();
  private readonly importsByFile = new Map<string, ImportRecord[]>();

  constructor(symbols: SymbolRecord[], imports: ImportRecord[]) {
    for (const s of symbols) {
      const list = this.byFile.get(s.path) ?? [];
      list.push(s);
      this.byFile.set(s.path, list);
    }
    for (const r of imports) {
      const list = this.importsByFile.get(r.from) ?? [];
      list.push(r);
      this.importsByFile.set(r.from, list);
    }
  }

  fileSymbols(path: string): SymbolRecord[] {
    return this.byFile.get(path) ?? [];
  }

  table(path: string): NameTable {
    let t = this.tables.get(path);
    if (t) return t;
    t = { local: new Map(), methods: new Map(), named: new Map(), modules: new Map(), external: new Map() };
    for (const s of this.fileSymbols(path)) {
      if (!s.parent) t.local.set(s.name, s);
      else if (s.kind === "method") {
        const m = t.methods.get(s.parent) ?? new Map<string, SymbolRecord>();
        m.set(s.name, s);
        t.methods.set(s.parent, m);
      }
    }
    for (const r of this.importsByFile.get(path) ?? []) {
      if (r.status === "external") {
        for (const n of r.names ?? []) t.external.set(n.alias, r.spec);
        continue;
      }
      if (r.status !== "resolved" || !r.resolved) continue;
      for (const n of r.names ?? []) {
        if (n.kind === "module" || n.kind === "namespace") t.modules.set(n.alias, r.resolved);
        else t.named.set(n.alias, { file: r.resolved, name: n.name });
      }
    }
    this.tables.set(path, t);
    return t;
  }

  moduleLevel(file: string, name: string, depth = 0): SymbolRecord | undefined {
    const t = this.table(file);
    const direct = t.local.get(name);
    if (direct) return direct;
    if (depth >= 3) return undefined;
    const re = t.named.get(name);
    if (re) return this.moduleLevel(re.file, re.name === "default" ? name : re.name, depth + 1);
    return undefined;
  }

  method(file: string, className: string, methodName: string): SymbolRecord | undefined {
    return this.table(file).methods.get(className)?.get(methodName);
  }

  resolveDotted(path: string, parts: string[], enclosing: SymbolRecord | undefined, builtins: Set<string>): Resolved {
    const t = this.table(path);
    const [head, ...rest] = parts;
    if (!head) return { kind: "complex", reason: "空表达式" };
    if (rest.length === 0) {
      const local = t.local.get(head);
      if (local) return { symbol: local, resolution: "same-file" };
      const named = t.named.get(head);
      if (named) {
        const target = this.moduleLevel(named.file, named.name === "default" ? head : named.name);
        return target ? { symbol: target, resolution: "import" } : { kind: "needs-types", reason: `导入的名字 ${head} 在 ${named.file} 里不是函数或类定义` };
      }
      const ext = t.external.get(head);
      if (ext) return { kind: "external", reason: `外部库 ${ext} 的 ${head}` };
      if (builtins.has(head)) return { kind: "builtin", reason: `内置 ${head}` };
      return { kind: "unknown-name", reason: `名字 ${head} 不是本文件定义，也不是导入` };
    }
    if (head === "self" || head === "cls" || head === "this") {
      const className = enclosing?.parent?.split(".").pop();
      if (!className) return { kind: "needs-types", reason: `${head} 出现在类之外` };
      const m = this.method(path, className, rest[0] ?? "");
      return m && rest.length === 1 ? { symbol: m, resolution: "self" } : { kind: "inherited", reason: `${head}.${rest.join(".")} 不是本类 ${className} 定义的方法，可能继承` };
    }
    if (t.external.has(head)) return { kind: "external", reason: `外部库 ${t.external.get(head)} 的 ${parts.join(".")}` };
    if (builtins.has(head)) return { kind: "builtin", reason: `内置 ${parts.join(".")}` };
    for (let i = parts.length - 1; i >= 1; i--) {
      const alias = parts.slice(0, i).join(".");
      const file = t.modules.get(alias);
      if (!file) continue;
      const tail = parts.slice(i);
      const first = tail[0] ?? "";
      if (tail.length === 1) {
        const target = this.moduleLevel(file, first);
        return target ? { symbol: target, resolution: "import" } : { kind: "needs-types", reason: `${alias} 里没有名为 ${first} 的函数或类` };
      }
      const cls = this.moduleLevel(file, first);
      const m = cls && cls.kind === "class" ? this.method(cls.path, cls.name, tail[1] ?? "") : undefined;
      return m && tail.length === 2 ? { symbol: m, resolution: "import" } : { kind: "needs-types", reason: `${parts.join(".")} 需要类型信息` };
    }
    const named = t.named.get(head);
    const cls = t.local.get(head) ?? (named ? this.moduleLevel(named.file, named.name) : undefined);
    if (cls && cls.kind === "class" && rest.length === 1) {
      const m = this.method(cls.path, cls.name, rest[0] ?? "");
      return m ? { symbol: m, resolution: cls.path === path ? "same-file" : "import" } : { kind: "inherited", reason: `类 ${cls.name} 没有定义方法 ${rest[0]}，可能继承` };
    }
    return { kind: "needs-types", reason: `${parts.join(".")} 是实例或属性上的调用，需要类型信息` };
  }
}

function dottedParts(node: Node, grammar: "python" | "js"): { parts: string[]; last: Node } | null {
  if (node.type === "identifier" || node.type === "this") return { parts: [node.text], last: node };
  if (grammar === "python" && node.type === "attribute") {
    const obj = node.childForFieldName("object");
    const attr = node.childForFieldName("attribute");
    if (!obj || !attr) return null;
    const head = dottedParts(obj, grammar);
    return head ? { parts: [...head.parts, attr.text], last: attr } : null;
  }
  if (grammar === "js" && node.type === "member_expression") {
    const obj = node.childForFieldName("object");
    const prop = node.childForFieldName("property");
    if (!obj || !prop) return null;
    const head = dottedParts(obj, grammar);
    return head ? { parts: [...head.parts, prop.text], last: prop } : null;
  }
  return null;
}

/** 单个文件的调用点，按语法提取。 */
export async function extractCallSites(file: string, source: string, grammar: GrammarName): Promise<CallSite[]> {
  const tree = await parse(grammar, source);
  if (!tree) return [];
  const kind = grammar === "python" ? "python" : "js";
  const callTypes = kind === "python" ? ["call"] : ["call_expression", "new_expression"];
  const sites: CallSite[] = [];
  for (const call of nodes(tree.rootNode.descendantsOfType(callTypes))) {
    const callee = call.childForFieldName(call.type === "new_expression" ? "constructor" : "function");
    if (!callee) continue;
    const dotted = dottedParts(callee, kind);
    const calleeText = callee.text.length > 80 ? callee.text.slice(0, 77) + "…" : callee.text;
    if (!dotted) sites.push({ line: call.startPosition.row + 1, col: callee.startPosition.column, parts: null, callee: calleeText, kind });
    else sites.push({ line: dotted.last.startPosition.row + 1, col: dotted.last.startPosition.column, parts: dotted.parts, callee: calleeText, kind });
  }
  return sites;
}

/** 用符号表和 import 表把所有文件的调用点解析成边；纯计算。 */
export function resolveCalls(sitesByFile: Map<string, CallSite[]>, symbols: SymbolRecord[], imports: ImportRecord[]): CallExtraction {
  const resolver = new Resolver(symbols, imports);
  const edges = new Map<string, CallEdge>();
  const unresolved: UnresolvedCall[] = [];
  let sites = 0;
  for (const [file, list] of sitesByFile) {
    const fileSymbols = resolver.fileSymbols(file);
    for (const site of list) {
      sites++;
      const enclosing = enclosingSymbol(fileSymbols, site.line);
      const from = enclosing?.id ?? moduleSymbolId(file);
      if (!site.parts) {
        unresolved.push({ path: file, line: site.line, col: site.col, callee: site.callee, from, kind: "complex", reason: "复杂调用表达式" });
        continue;
      }
      const builtins = site.kind === "python" ? PYTHON_BUILTINS : JS_BUILTINS;
      const result = resolver.resolveDotted(file, site.parts, enclosing, builtins);
      if ("symbol" in result) {
        if (result.symbol.id === from) continue;
        const key = `${from}\u0000${result.symbol.id}\u0000${site.line}`;
        if (!edges.has(key)) edges.set(key, { from, to: result.symbol.id, evidence: { path: file, line: site.line, note: site.callee }, resolution: result.resolution });
      } else {
        unresolved.push({ path: file, line: site.line, col: site.col, callee: site.callee, from, kind: result.kind, reason: result.reason });
      }
    }
  }
  return { edges: [...edges.values()], unresolved, sites };
}
