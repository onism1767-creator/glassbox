import { createRequire } from "node:module";
import path from "node:path";
import type { Parser as ParserClass, Language as LanguageClass, Tree, Node } from "@vscode/tree-sitter-wasm";

export type { Tree, Node };

export type GrammarName = "python" | "javascript" | "typescript" | "tsx";

interface TreeSitterModule {
  Parser: typeof ParserClass;
  Language: typeof LanguageClass;
}

const require = createRequire(import.meta.url);
const wasmDir = path.join(path.dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")), "wasm");

let runtime: Promise<TreeSitterModule> | null = null;
const languages = new Map<GrammarName, Promise<LanguageClass>>();
const parsers = new Map<GrammarName, ParserClass>();

export function grammarFor(language: string): GrammarName | null {
  switch (language) {
    case "python":
    case "javascript":
    case "typescript":
    case "tsx":
      return language;
    default:
      return null;
  }
}

async function treeSitter(): Promise<TreeSitterModule> {
  if (!runtime) {
    runtime = (async () => {
      const mod = require("@vscode/tree-sitter-wasm") as TreeSitterModule;
      await mod.Parser.init({ locateFile: (file: string) => path.join(wasmDir, file) });
      return mod;
    })();
  }
  return runtime;
}

export async function loadLanguage(name: GrammarName): Promise<LanguageClass> {
  let pending = languages.get(name);
  if (!pending) {
    pending = (async () => {
      const { Language } = await treeSitter();
      return Language.load(path.join(wasmDir, `tree-sitter-${name}.wasm`));
    })();
    languages.set(name, pending);
  }
  return pending;
}

export async function parse(name: GrammarName, source: string): Promise<Tree | null> {
  let parser = parsers.get(name);
  if (!parser) {
    const { Parser } = await treeSitter();
    parser = new Parser();
    parser.setLanguage(await loadLanguage(name));
    parsers.set(name, parser);
  }
  return parser.parse(source);
}

/** 去掉字符串字面量两端的引号。 */
export function unquote(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) || (t.startsWith("`") && t.endsWith("`")))) {
    return t.slice(1, -1);
  }
  return t;
}
