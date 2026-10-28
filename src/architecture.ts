/**
 * 架构落地率：架构书（Markdown，T2 声明）里写到的文件、目录、类、函数，对照索引里真实存在的（T0）。
 * 每项标"存在 / 缺失"，落地率 = 存在数 / 声明数；反过来，代码里有但架构书没提的，列成"多出"，提示文档落后。
 * 只做机械抽取：目录树代码块、接口伪代码、反引号里的路径和标识符、正文里的驼峰类名；不用 LLM。
 */
import type { Evidence, FileRecord, SymbolRecord, Tier } from "./types.ts";
import { topDir } from "./rules.ts";

export type ArchKind = "file" | "dir" | "class" | "function";

export interface ArchDeclaration {
  kind: ArchKind;
  name: string;
  /** 最近的标题，像「第 6 章 接口与数据契约」。 */
  chapter: string;
  /** 架构书里的位置。 */
  evidence: Evidence;
  /** 架构书里提到的次数。 */
  mentions: number;
  /** 弱声明：只在正文里以驼峰词出现（可能是产品名、外部名字），不算进落地率，只做提示。 */
  weak?: boolean;
  status: "present" | "missing";
  /** 代码里的位置（存在时，最多三处）。 */
  found?: Evidence[];
  hint?: string;
}

export interface ArchitectureSnapshot {
  source: { file: string; tier: Tier; headings: number };
  declarations: ArchDeclaration[];
  summary: {
    declared: number;
    present: number;
    missing: number;
    /** 0–100。 */
    rate: number;
    files: { declared: number; present: number };
    symbols: { declared: number; present: number };
  };
  byChapter: { chapter: string; declared: number; present: number; missing: string[] }[];
  /** 正文里的驼峰词：代码里有多少、没有的是哪些（不算进落地率）。 */
  weak: { present: number; missing: { name: string; evidence: Evidence }[] };
  /** 代码里有、架构书一个字没提的。 */
  extra: { dirs: string[]; files: number; classes: { name: string; path: string; line: number }[] };
  howTo: string;
}

const CODE_EXT = /\.(py|pyi|yaml|yml|json|toml|md|txt|js|jsx|ts|tsx|mjs|cjs|html|css|sql|ini|cfg|ps1|sh)$/i;
/** 驼峰类名：至少两个"大写开头的词"，像 SurfaceAdapter、BrandMentionObservation。 */
const CAMEL = /\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)\b/g;
const TREE_LINE = /^([│ ]*)(?:├──|└──)\s*([^\s#]+)/;
const IFACE = /^\s*(?:interface|class)\s+([A-Za-z_]\w*)/;
const FUNC_IN_BLOCK = /^\s*(?:async\s+)?(?:def\s+)?([a-z_][a-z0-9_]*)\s*\([^)]*\)\s*(?:->|:|$)/;
const BACKTICK = /`([^`\n]+)`/g;
const FUNC_CALL_WORD = /^([a-z_][a-z0-9_]*)\(\)?$/;

/** 不当成项目类名的词：常见技术、语言、格式、Python 内置异常。依赖清单里的名字另外传进来。 */
const STOP_WORDS = new Set(
  [
    "Markdown", "PostgreSQL", "Postgres", "Playwright", "FastAPI", "JavaScript", "TypeScript", "GitHub", "OpenAI", "ChatGPT", "DeepSeek", "Anthropic", "Perplexity", "Gemini", "Claude", "Jinja", "Pydantic", "SQLite", "MySQL", "Redis", "Docker", "Kubernetes", "GraphQL", "WebSocket", "OAuth", "HttpX", "Httpx", "TailwindCSS", "NodeJS", "MacOS", "PowerShell", "CamelCase", "SnakeCase", "PyPI", "Jupyter", "NumPy", "SciPy", "LangChain", "OpenTelemetry", "YouTube", "WeChat", "WordPress", "RobotsTxt",
    "ValueError", "TypeError", "KeyError", "AttributeError", "RuntimeError", "IndexError", "ImportError", "NotImplementedError", "FileNotFoundError", "TimeoutError", "ConnectionError", "StopIteration", "BaseException", "SystemExit", "KeyboardInterrupt", "OSError", "IOError", "AssertionError", "LookupError", "ZeroDivisionError", "UnicodeDecodeError",
  ].map((w) => w.toLowerCase()),
);

function isStop(word: string, extra: Set<string>): boolean {
  const w = word.toLowerCase();
  return STOP_WORDS.has(w) || extra.has(w) || extra.has(w.replace(/-/g, "_"));
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** 从架构书正文抽声明。 */
export function parseArchitecture(text: string, docPath: string, stop: Set<string> = new Set()): { declarations: ArchDeclaration[]; headings: number } {
  const lines = text.split("\n");
  const byKey = new Map<string, ArchDeclaration>();
  let chapter = "开头";
  let headings = 0;
  let inFence = false;
  let treeStack: string[] = [];
  const add = (kind: ArchKind, name: string, line: number, weak = false): void => {
    const key = `${kind}:${name}`;
    const hit = byKey.get(key);
    if (hit) {
      hit.mentions++;
      // 同一个名字在代码块或反引号里出现过，就不再是弱声明。
      if (!weak && hit.weak) {
        hit.weak = false;
        hit.chapter = chapter;
        hit.evidence = { path: docPath, line };
      }
      return;
    }
    byKey.set(key, { kind, name, chapter, evidence: { path: docPath, line }, mentions: 1, ...(weak ? { weak: true } : {}), status: "missing" });
  };
  const addPathLike = (raw: string, line: number): boolean => {
    const p = normPath(raw.trim());
    if (!p || /\s/.test(p) || p.includes("..") || p.startsWith("http") || p.startsWith("?") || p.startsWith("/")) return false;
    if (p.endsWith("/")) {
      if (/^[\w.-]+(\/[\w.-]+)*\/$/.test(p)) {
        add("dir", p.replace(/\/+$/, ""), line);
        return true;
      }
      return false;
    }
    if (p.includes("/") || CODE_EXT.test(p)) {
      if (/^[\w.-]+(\/[\w.-]+)*$/.test(p) && CODE_EXT.test(p)) {
        add("file", p, line);
        return true;
      }
      if (/^[\w.-]+(\/[\w.-]+)+$/.test(p) && !p.includes(".")) {
        add("dir", p, line);
        return true;
      }
    }
    return false;
  };
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      treeStack = [];
      return;
    }
    if (!inFence && /^#{1,4}\s/.test(raw)) {
      chapter = raw.replace(/^#+\s*/, "").trim();
      headings++;
      return;
    }
    if (inFence) {
      const t = TREE_LINE.exec(raw);
      if (t) {
        const depth = Math.floor((t[1] ?? "").length / 4);
        const name = t[2]!;
        treeStack = treeStack.slice(0, depth);
        const prefix = treeStack.join("/");
        if (name.endsWith("/")) {
          const dir = name.replace(/\/+$/, "");
          treeStack[depth] = dir;
          add("dir", prefix ? `${prefix}/${dir}` : dir, line);
        } else if (CODE_EXT.test(name)) {
          add("file", prefix ? `${prefix}/${name}` : name, line);
        }
        return;
      }
      const iface = IFACE.exec(raw);
      if (iface) {
        add("class", iface[1]!, line);
        return;
      }
      const fn = FUNC_IN_BLOCK.exec(raw);
      if (fn && !/^(if|for|while|return|print|with|elif|except|raise|assert)$/.test(fn[1]!)) {
        add("function", fn[1]!, line);
        return;
      }
      // 数据模型树的根：一行只有一个驼峰名。
      const lone = /^\s*([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)\s*(?:\(.*\))?\s*$/.exec(raw);
      if (lone && !isStop(lone[1]!, stop)) add("class", lone[1]!, line);
      return;
    }
    for (const m of raw.matchAll(BACKTICK)) {
      const inner = m[1]!.trim();
      if (addPathLike(inner, line)) continue;
      const call = FUNC_CALL_WORD.exec(inner);
      if (call && inner.endsWith(")")) {
        add("function", call[1]!, line);
        continue;
      }
      if (/^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+$/.test(inner) && !isStop(inner, stop)) add("class", inner, line);
    }
    const prose = raw.replace(BACKTICK, " ");
    for (const m of prose.matchAll(CAMEL)) {
      const word = m[1]!;
      if (!isStop(word, stop)) add("class", word, line, true);
    }
  });
  return { declarations: [...byKey.values()], headings };
}

export interface ArchWorld {
  files: FileRecord[];
  symbols: SymbolRecord[];
}

/** 把声明对照索引，算落地率和"多出"。 */
export function compareArchitecture(parsed: { declarations: ArchDeclaration[]; headings: number }, world: ArchWorld, docPath: string, docText: string): ArchitectureSnapshot {
  const paths = new Set(world.files.map((f) => f.path));
  const byBase = new Map<string, string[]>();
  for (const p of paths) {
    const base = p.slice(p.lastIndexOf("/") + 1);
    byBase.set(base, [...(byBase.get(base) ?? []), p]);
  }
  const symbolsByName = new Map<string, SymbolRecord[]>();
  for (const s of world.symbols) symbolsByName.set(s.name, [...(symbolsByName.get(s.name) ?? []), s]);
  const allNames = [...symbolsByName.keys()];
  const similar = (name: string): string[] => {
    const n = name.toLowerCase();
    return allNames.filter((x) => x !== name && x.length >= 4 && (x.toLowerCase().includes(n) || n.includes(x.toLowerCase()))).slice(0, 3);
  };
  const declarations = parsed.declarations.map((d): ArchDeclaration => {
    if (d.kind === "file") {
      if (paths.has(d.name)) return { ...d, status: "present", found: [{ path: d.name }] };
      const base = d.name.slice(d.name.lastIndexOf("/") + 1);
      const same = byBase.get(base) ?? [];
      // 书里只写了文件名没写目录：只有一个同名文件就认它。
      if (!d.name.includes("/") && same.length === 1) return { ...d, status: "present", found: [{ path: same[0]!, note: "书里只写了文件名" }] };
      return { ...d, status: "missing", ...(same.length ? { hint: `同名文件在 ${same.slice(0, 3).join("、")}` } : {}) };
    }
    if (d.kind === "dir") {
      const under = [...paths].filter((p) => p.startsWith(d.name + "/"));
      return under.length ? { ...d, status: "present", found: [{ path: under[0]!, note: `${under.length} 个文件` }] } : { ...d, status: "missing" };
    }
    const syms = symbolsByName.get(d.name) ?? [];
    const preferred = d.kind === "class" ? syms.filter((s) => s.kind === "class") : syms.filter((s) => s.kind !== "class");
    const use = preferred.length ? preferred : syms;
    if (!use.length) {
      const near = similar(d.name);
      return { ...d, status: "missing", ...(near.length ? { hint: `有相近的名字：${near.join("、")}` } : {}) };
    }
    return {
      ...d,
      status: "present",
      found: use.slice(0, 3).map((s) => ({ path: s.path, line: s.startLine, note: s.kind })),
      ...(preferred.length ? {} : { hint: `找到的是${use[0]!.kind === "class" ? "类" : "函数"}，和架构书写法不同` }),
    };
  });
  const strong = declarations.filter((d) => !d.weak);
  const weakOnes = declarations.filter((d) => d.weak);
  const present = strong.filter((d) => d.status === "present").length;
  const isFileish = (d: ArchDeclaration) => d.kind === "file" || d.kind === "dir";
  const chapters = new Map<string, ArchitectureSnapshot["byChapter"][number]>();
  for (const d of strong) {
    const c = chapters.get(d.chapter) ?? { chapter: d.chapter, declared: 0, present: 0, missing: [] };
    c.declared++;
    if (d.status === "present") c.present++;
    else c.missing.push(d.name);
    chapters.set(d.chapter, c);
  }
  // 多出：代码里的顶层目录、文件、类，架构书里一个字没提。
  const lower = docText.toLowerCase();
  const mentioned = (s: string) => lower.includes(s.toLowerCase());
  const tops = [...new Set(world.files.map((f) => topDir(f.path)))].filter((d) => d !== "." && !d.startsWith("."));
  const extraDirs = tops.filter((d) => !mentioned(d + "/") && !mentioned("`" + d + "`") && !new RegExp(`\\b${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(docText));
  const codeFiles = world.files.filter((f) => !f.binary && /\.(py|ts|tsx|js)$/.test(f.path) && !f.path.includes("__init__") && !f.path.startsWith("tests/") && !f.path.startsWith("."));
  const extraFiles = codeFiles.filter((f) => !mentioned(f.path) && !mentioned(f.path.slice(f.path.lastIndexOf("/") + 1))).length;
  const extraClasses = world.symbols
    .filter((s) => s.kind === "class" && !s.name.startsWith("_") && !s.path.startsWith("tests/") && !mentioned(s.name))
    .map((s) => ({ name: s.name, path: s.path, line: s.startLine }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const files = strong.filter(isFileish);
  const symbols = strong.filter((d) => !isFileish(d));
  return {
    source: { file: docPath, tier: "T2", headings: parsed.headings },
    declarations,
    summary: {
      declared: strong.length,
      present,
      missing: strong.length - present,
      rate: strong.length ? Math.round((present / strong.length) * 1000) / 10 : 0,
      files: { declared: files.length, present: files.filter((d) => d.status === "present").length },
      symbols: { declared: symbols.length, present: symbols.filter((d) => d.status === "present").length },
    },
    byChapter: [...chapters.values()],
    weak: { present: weakOnes.filter((d) => d.status === "present").length, missing: weakOnes.filter((d) => d.status === "missing").map((d) => ({ name: d.name, evidence: d.evidence })) },
    extra: { dirs: extraDirs, files: extraFiles, classes: extraClasses },
    howTo: "只有写在目录树、接口伪代码、反引号里的文件、目录、类、函数名才算声明；正文里的驼峰词只做提示（常是产品名或外部名字）。缺失的要么还没写，要么改了名没改书；多出的是代码里有、书里没提的。",
  };
}

export function buildArchitecture(source: { file: string; text: string }, world: ArchWorld, stop: Set<string> = new Set()): ArchitectureSnapshot {
  return compareArchitecture(parseArchitecture(source.text, source.file, stop), world, source.file, source.text);
}

/** 没在 overlay 里指定时，根目录下名字带「架构」或 architecture 的 Markdown 就当架构书。 */
export function guessArchitectureFile(files: FileRecord[]): string | undefined {
  const cands = files.filter((f) => !f.path.includes("/") && /\.md$/i.test(f.path) && /架构|architecture/i.test(f.path)).map((f) => f.path).sort();
  return cands[0];
}
