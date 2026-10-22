import { parse, grammarFor, type Node, type GrammarName } from "./parser.ts";
import type { FileRecord, SymbolRecord, SymbolKind } from "./types.ts";

function nodes(list: (Node | null)[]): Node[] {
  return list.filter((n): n is Node => n !== null);
}

export function symbolId(path: string, qualified: string): string {
  return `${path}::${qualified}`;
}

export function moduleSymbolId(path: string): string {
  return symbolId(path, "<module>");
}

interface Frame {
  name: string;
  kind: SymbolKind;
}

function record(path: string, stack: Frame[], name: string, kind: SymbolKind, node: Node, extra: Partial<SymbolRecord> = {}): SymbolRecord {
  const qualified = [...stack.map((f) => f.name), name].join(".");
  const parent = stack.length ? stack.map((f) => f.name).join(".") : undefined;
  return {
    id: symbolId(path, qualified),
    path,
    kind,
    name,
    qualified,
    ...(parent ? { parent } : {}),
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    ...extra,
  };
}

function pythonSymbols(path: string, root: Node): SymbolRecord[] {
  const out: SymbolRecord[] = [];
  const walk = (node: Node, stack: Frame[]): void => {
    for (const child of nodes(node.namedChildren)) {
      const target = child.type === "decorated_definition" ? child.childForFieldName("definition") : child;
      if (!target) continue;
      if (target.type === "function_definition" || target.type === "class_definition") {
        const name = target.childForFieldName("name")?.text;
        if (!name) continue;
        const inClass = stack[stack.length - 1]?.kind === "class";
        const kind: SymbolKind = target.type === "class_definition" ? "class" : inClass ? "method" : "function";
        out.push(record(path, stack, name, kind, child));
        const body = target.childForFieldName("body");
        if (body) walk(body, [...stack, { name, kind }]);
        continue;
      }
      walk(child, stack);
    }
  };
  walk(root, []);
  return out;
}

function hasDefaultKeyword(exportNode: Node): boolean {
  return nodes(exportNode.children).some((c) => c.type === "default");
}

function jsSymbols(path: string, root: Node): SymbolRecord[] {
  const out: SymbolRecord[] = [];
  const walk = (node: Node, stack: Frame[], exported: boolean, isDefault: boolean): void => {
    for (const child of nodes(node.namedChildren)) {
      if (child.type === "export_statement") {
        walk(child, stack, true, hasDefaultKeyword(child));
        continue;
      }
      const t = child.type;
      if (t === "function_declaration" || t === "generator_function_declaration" || t === "class_declaration" || t === "abstract_class_declaration") {
        const name = child.childForFieldName("name")?.text ?? (isDefault ? "default" : "");
        if (!name) continue;
        const kind: SymbolKind = t.includes("class") ? "class" : "function";
        out.push(record(path, stack, name, kind, child, { ...(exported ? { exported: true } : {}), ...(isDefault ? { isDefault: true } : {}) }));
        const body = child.childForFieldName("body");
        if (body) walk(body, [...stack, { name, kind }], false, false);
        continue;
      }
      if (t === "method_definition" || t === "public_field_definition") {
        const name = child.childForFieldName("name")?.text;
        const value = child.childForFieldName("value");
        const isFunction = t === "method_definition" || (value !== null && (value.type === "arrow_function" || value.type === "function_expression"));
        if (!name || !isFunction) continue;
        out.push(record(path, stack, name, "method", child));
        const body = child.childForFieldName("body") ?? value?.childForFieldName("body") ?? null;
        if (body) walk(body, [...stack, { name, kind: "method" }], false, false);
        continue;
      }
      if (t === "lexical_declaration" || t === "variable_declaration") {
        for (const decl of nodes(child.namedChildren)) {
          if (decl.type !== "variable_declarator") continue;
          const nameNode = decl.childForFieldName("name");
          const value = decl.childForFieldName("value");
          if (!nameNode || nameNode.type !== "identifier" || !value) continue;
          if (value.type !== "arrow_function" && value.type !== "function_expression" && value.type !== "function") continue;
          out.push(record(path, stack, nameNode.text, "function", decl, exported ? { exported: true } : {}));
          const body = value.childForFieldName("body");
          if (body) walk(body, [...stack, { name: nameNode.text, kind: "function" }], false, false);
        }
        continue;
      }
      walk(child, stack, false, false);
    }
  };
  walk(root, [], false, false);
  return out;
}

/** 单个文件的符号。 */
export async function extractFileSymbols(file: string, source: string, grammar: GrammarName): Promise<SymbolRecord[]> {
  const tree = await parse(grammar, source);
  if (!tree) return [];
  return grammar === "python" ? pythonSymbols(file, tree.rootNode) : jsSymbols(file, tree.rootNode);
}

export async function extractSymbols(files: FileRecord[], contents: Map<string, string>): Promise<SymbolRecord[]> {
  const all: SymbolRecord[] = [];
  for (const f of files) {
    const grammar = grammarFor(f.language);
    const source = contents.get(f.path);
    if (!grammar || source === undefined) continue;
    all.push(...(await extractFileSymbols(f.path, source, grammar)));
  }
  return all;
}

/** 某文件里包含某一行的最内层符号。 */
export function enclosingSymbol(fileSymbols: SymbolRecord[], line: number): SymbolRecord | undefined {
  let best: SymbolRecord | undefined;
  for (const s of fileSymbols) {
    if (s.startLine <= line && line <= s.endLine) {
      if (!best || s.startLine >= best.startLine) best = s;
    }
  }
  return best;
}
