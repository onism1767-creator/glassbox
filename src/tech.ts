import type { ImportRecord, Tier } from "./types.ts";

export interface TechDeclared {
  name: string;
  spec: string;
  source: "pyproject" | "package.json" | "requirements";
  file: string;
  dev?: boolean;
}

export interface TechUsed {
  /** 对外的名字（声明名或 import 的顶层模块名）。 */
  name: string;
  module: string;
  imports: number;
  files: number;
  kind: "third-party" | "stdlib" | "node-builtin";
  /** 匹配到的声明。 */
  declared?: TechDeclared;
}

export interface TechStack {
  declared: TechDeclared[];
  used: TechUsed[];
  /** 代码里 import 了、声明里找不到的第三方库（可能是传递依赖或别名）。 */
  undeclared: string[];
  /** 声明了、代码里没见 import 的。 */
  unused: TechDeclared[];
  tiers: { declared: Tier; used: Tier; match: Tier };
}

export interface Manifest {
  path: string;
  text: string;
}

const PY_STDLIB = new Set("abc aifc argparse array ast asyncio atexit base64 bdb binascii bisect builtins bz2 calendar cgi cmath cmd code codecs codeop collections colorsys compileall concurrent configparser contextlib contextvars copy copyreg cProfile csv ctypes curses dataclasses datetime dbm decimal difflib dis doctest email encodings enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http imaplib importlib inspect io ipaddress itertools json keyword linecache locale logging lzma mailbox marshal math mimetypes mmap modulefinder multiprocessing netrc numbers operator optparse os pathlib pdb pickle pickletools pkgutil platform plistlib poplib posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc queue quopri random re readline reprlib resource runpy sched secrets select selectors shelve shlex shutil signal site smtplib socket socketserver sqlite3 ssl stat statistics string stringprep struct subprocess sys sysconfig syslog tabnanny tarfile tempfile termios textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle types typing unicodedata unittest urllib uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xml xmlrpc zipapp zipfile zipimport zlib zoneinfo __future__ _thread".split(" "));
const NODE_BUILTINS = new Set("assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib sqlite test".split(" "));

/** 发行名 → import 名 的常见差异。 */
const PY_ALIASES: Record<string, string> = {
  pyyaml: "yaml", beautifulsoup4: "bs4", pillow: "PIL", "scikit-learn": "sklearn", "python-dotenv": "dotenv", "opencv-python": "cv2",
  "psycopg2-binary": "psycopg2", attrs: "attr", "typing-extensions": "typing_extensions", "python-dateutil": "dateutil", "markdown-it-py": "markdown_it",
  "ruamel.yaml": "ruamel", "pyjwt": "jwt", "python-multipart": "multipart", "protobuf": "google", "msgpack-python": "msgpack", "pytest-asyncio": "pytest_asyncio",
};

function normalize(name: string): string {
  return name.toLowerCase().replace(/\[.*\]$/, "").replace(/[-.]/g, "_");
}

function specName(spec: string): string {
  return spec.trim().replace(/^["']|["'],?$/g, "").split(/[\s;<>=!~([@]/)[0]?.trim() ?? "";
}

function parsePyproject(text: string, file: string): TechDeclared[] {
  const out: TechDeclared[] = [];
  // [project] dependencies = [...] 与 [project.optional-dependencies] 的各组、[dependency-groups]
  const arrayRx = /^\s*([\w-]+)\s*=\s*\[([\s\S]*?)\]/gm;
  let section = "";
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const sec = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sec) {
      section = sec[1] ?? "";
      i++;
      continue;
    }
    const arr = /^\s*([\w.-]+)\s*=\s*\[/.exec(line);
    if (arr && (section === "project" || section === "project.optional-dependencies" || section === "dependency-groups" || section === "build-system")) {
      const key = arr[1] ?? "";
      // 逐字符找到数组真正的右括号：引号里的 ] （如 "pydantic[email]"）不算。
      let body = "";
      let text = line.slice(line.indexOf("[") + 1);
      let closed = false;
      for (;;) {
        let quote: string | null = null;
        let cut = -1;
        for (let k = 0; k < text.length; k++) {
          const ch = text[k];
          if (quote) {
            if (ch === quote) quote = null;
          } else if (ch === '"' || ch === "'") quote = ch;
          else if (ch === "]") {
            cut = k;
            break;
          }
        }
        if (cut >= 0) {
          body += text.slice(0, cut);
          closed = true;
          break;
        }
        body += text + "\n";
        if (i + 1 >= lines.length) break;
        i++;
        text = lines[i] ?? "";
      }
      if (!closed) body = body.trimEnd();
      const isDeps = section === "project" ? key === "dependencies" : section !== "build-system";
      if (isDeps) {
        for (const m of body.matchAll(/["']([^"']+)["']/g)) {
          const spec = m[1] ?? "";
          const name = specName(spec);
          if (name) out.push({ name, spec, source: "pyproject", file, ...(section === "project" ? {} : { dev: true }) });
        }
      }
      i++;
      continue;
    }
    if (section === "tool.poetry.dependencies" || section === "tool.poetry.dev-dependencies" || section.startsWith("tool.poetry.group.")) {
      const kv = /^\s*([\w.-]+)\s*=\s*(.+)$/.exec(line);
      if (kv && kv[1] !== "python") out.push({ name: kv[1] ?? "", spec: (kv[2] ?? "").replace(/^["']|["']$/g, ""), source: "pyproject", file, ...(section === "tool.poetry.dependencies" ? {} : { dev: true }) });
    }
    i++;
  }
  void arrayRx;
  return out;
}

function parseRequirements(text: string, file: string): TechDeclared[] {
  const out: TechDeclared[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || line.startsWith("-")) continue;
    const name = specName(line);
    if (name) out.push({ name, spec: line, source: "requirements", file });
  }
  return out;
}

function parsePackageJson(text: string, file: string): TechDeclared[] {
  try {
    const json = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const out: TechDeclared[] = [];
    for (const [name, spec] of Object.entries(json.dependencies ?? {})) out.push({ name, spec, source: "package.json", file });
    for (const [name, spec] of Object.entries(json.devDependencies ?? {})) out.push({ name, spec, source: "package.json", file, dev: true });
    return out;
  } catch {
    return [];
  }
}

export function parseManifests(manifests: Manifest[]): TechDeclared[] {
  const out: TechDeclared[] = [];
  for (const m of manifests) {
    const base = m.path.split("/").pop() ?? "";
    if (base === "pyproject.toml") out.push(...parsePyproject(m.text, m.path));
    else if (base === "package.json") out.push(...parsePackageJson(m.text, m.path));
    else if (/^requirements.*\.txt$/.test(base)) out.push(...parseRequirements(m.text, m.path));
  }
  return out;
}

/** import 规格 → 顶层包名：`a.b.c` → a；`@scope/pkg/x` → @scope/pkg；`node:fs` → fs。 */
export function topLevelPackage(spec: string, kind: "python" | "js"): { module: string; builtin: boolean } {
  if (kind === "python") {
    const top = spec.split(".")[0] ?? spec;
    return { module: top, builtin: PY_STDLIB.has(top) };
  }
  if (spec.startsWith("node:")) return { module: spec.slice(5), builtin: true };
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return { module: parts.slice(0, 2).join("/"), builtin: false };
  }
  const top = spec.split("/")[0] ?? spec;
  return { module: top, builtin: NODE_BUILTINS.has(top) };
}

export function computeTech(imports: ImportRecord[], manifests: Manifest[]): TechStack {
  const declared = parseManifests(manifests);
  const byNorm = new Map<string, TechDeclared>();
  for (const d of declared) {
    byNorm.set(normalize(d.name), d);
    const alias = PY_ALIASES[d.name.toLowerCase()];
    if (alias) byNorm.set(normalize(alias), d);
  }
  const usage = new Map<string, { module: string; imports: number; files: Set<string>; kind: TechUsed["kind"] }>();
  for (const r of imports) {
    if (r.status !== "external" || !r.spec) continue;
    const kind = r.from.endsWith(".py") || r.from.endsWith(".pyi") ? "python" : "js";
    const { module, builtin } = topLevelPackage(r.spec.replace(/^\.+/, ""), kind);
    if (!module) continue;
    const key = `${kind}:${module}`;
    const entry = usage.get(key) ?? { module, imports: 0, files: new Set<string>(), kind: builtin ? (kind === "python" ? "stdlib" : "node-builtin") : "third-party" };
    entry.imports++;
    entry.files.add(r.from);
    usage.set(key, entry);
  }
  const used: TechUsed[] = [];
  const matched = new Set<TechDeclared>();
  for (const u of usage.values()) {
    const d = u.kind === "third-party" ? byNorm.get(normalize(u.module)) : undefined;
    if (d) matched.add(d);
    used.push({ name: d?.name ?? u.module, module: u.module, imports: u.imports, files: u.files.size, kind: u.kind, ...(d ? { declared: d } : {}) });
  }
  used.sort((a, b) => (a.kind === b.kind ? b.imports - a.imports : a.kind === "third-party" ? -1 : b.kind === "third-party" ? 1 : a.kind.localeCompare(b.kind)));
  const undeclared = used.filter((u) => u.kind === "third-party" && !u.declared).map((u) => u.module);
  const unused = declared.filter((d) => !matched.has(d));
  return { declared, used, undeclared, unused, tiers: { declared: "T0", used: "T0", match: "T1" } };
}
