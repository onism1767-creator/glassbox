/**
 * 精确层：驱动 pyright 语言服务器，对语法层解不到的调用做「跳到定义」。
 * pyright 是纯 JS、Windows 可用；scip-python 0.6.7 在 Windows 启动即崩，故不用。
 * 会话可以常驻：文件变了只发 didChange，再只重问那个文件的调用点。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { CallEdge, UnresolvedCall, SymbolRecord } from "./types.ts";

const require = createRequire(import.meta.url);

export function pyrightServerEntry(): string | null {
  try {
    return require.resolve("pyright/langserver.index.js");
  } catch {
    return null;
  }
}

/** 猜项目的解释器：仓库里的 .venv / venv，否则交给 pyright 自己找。 */
export function guessPythonPath(root: string): string | undefined {
  for (const dir of [".venv", "venv"]) {
    for (const candidate of [path.join(root, dir, "Scripts", "python.exe"), path.join(root, dir, "bin", "python")]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

interface Message {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

class LspClient {
  private readonly child: ChildProcess;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly settings: unknown;
  exited = false;

  constructor(entry: string, root: string, settings: unknown) {
    this.settings = settings;
    this.child = spawn(process.execPath, [entry, "--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr?.on("data", () => undefined);
    this.child.stdin?.on("error", () => undefined);
    this.child.stdout?.on("error", () => undefined);
    this.child.on("error", () => undefined);
    this.child.on("exit", () => {
      this.exited = true;
      for (const p of this.pending.values()) p.reject(new Error("pyright 退出"));
      this.pending.clear();
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      try {
        this.onMessage(JSON.parse(body) as Message);
      } catch {
        /* 忽略坏消息 */
      }
    }
  }

  private onMessage(msg: Message): void {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) {
      const result = msg.method === "workspace/configuration" ? ((msg.params as { items?: unknown[] })?.items ?? []).map(() => this.settings) : null;
      this.send({ jsonrpc: "2.0", id: msg.id, result });
    }
  }

  private send(msg: Message): void {
    const stdin = this.child.stdin;
    if (this.exited || !stdin || stdin.destroyed || !stdin.writable) return;
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    try {
      stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      stdin.write(body);
    } catch {
      /* 进程已退出 */
    }
  }

  request<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** 按协议先 shutdown 再 exit；两秒内没退出就强杀。 */
  async close(): Promise<void> {
    if (this.exited) return;
    try {
      await this.request("shutdown", null, 5_000);
    } catch {
      /* 服务器可能已经挂了 */
    }
    this.notify("exit", null);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.child.kill();
        } catch {
          /* ignore */
        }
        resolve();
      }, 2_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      if (this.exited) {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

interface Location {
  uri: string;
  range: { start: { line: number; character: number } };
}
interface LocationLink {
  targetUri: string;
  targetRange: { start: { line: number; character: number } };
  targetSelectionRange?: { start: { line: number; character: number } };
}

export type Definition = { kind: "internal"; path: string; line: number } | { kind: "external" } | { kind: "none" };

/** 一个常驻的 pyright 会话。 */
export class PyrightSession {
  readonly root: string;
  private client: LspClient | null = null;
  private readonly open = new Map<string, { version: number; text: string }>();
  private initializing: Promise<void> | null = null;

  constructor(root: string) {
    this.root = root;
  }

  static available(): boolean {
    return pyrightServerEntry() !== null;
  }

  private async ensure(): Promise<LspClient> {
    if (this.client && !this.client.exited) {
      if (this.initializing) await this.initializing;
      return this.client;
    }
    const entry = pyrightServerEntry();
    if (!entry) throw new Error("未安装 pyright（npm install pyright）");
    const pythonPath = guessPythonPath(this.root);
    const settings = { pythonPath, analysis: { autoSearchPaths: true, diagnosticMode: "openFilesOnly", typeCheckingMode: "off", logLevel: "Error" } };
    const client = new LspClient(entry, this.root, settings);
    this.client = client;
    this.open.clear();
    const rootUri = pathToFileURL(this.root).href;
    this.initializing = (async () => {
      await client.request("initialize", {
        processId: process.pid,
        rootUri,
        capabilities: { textDocument: { definition: { linkSupport: true } }, workspace: { configuration: true } },
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) }],
        initializationOptions: {},
      }, 120_000);
      client.notify("initialized", {});
      client.notify("workspace/didChangeConfiguration", { settings: { python: settings } });
    })();
    await this.initializing;
    this.initializing = null;
    return client;
  }

  private uri(file: string): string {
    return pathToFileURL(path.join(this.root, file)).href;
  }

  /** 打开或更新一个文件的内容。 */
  async sync(file: string, text: string): Promise<void> {
    const client = await this.ensure();
    const current = this.open.get(file);
    if (!current) {
      this.open.set(file, { version: 1, text });
      client.notify("textDocument/didOpen", { textDocument: { uri: this.uri(file), languageId: "python", version: 1, text } });
    } else if (current.text !== text) {
      current.version++;
      current.text = text;
      client.notify("textDocument/didChange", { textDocument: { uri: this.uri(file), version: current.version }, contentChanges: [{ text }] });
    }
  }

  async forget(file: string): Promise<void> {
    if (!this.open.has(file) || !this.client) return;
    this.open.delete(file);
    this.client.notify("textDocument/didClose", { textDocument: { uri: this.uri(file) } });
  }

  /** 「跳到定义」：返回仓库内的文件与行、仓库外、或没有。 */
  async definition(file: string, line: number, col: number): Promise<Definition> {
    const client = await this.ensure();
    let locations: (Location | LocationLink)[] | Location | null = null;
    try {
      locations = await client.request("textDocument/definition", { textDocument: { uri: this.uri(file) }, position: { line: line - 1, character: col } }, 30_000);
    } catch {
      return { kind: "none" };
    }
    const list = Array.isArray(locations) ? locations : locations ? [locations] : [];
    const first = list[0];
    if (!first) return { kind: "none" };
    const targetUri = "targetUri" in first ? first.targetUri : first.uri;
    const start = "targetUri" in first ? (first.targetSelectionRange ?? first.targetRange).start : first.range.start;
    let targetPath: string;
    try {
      targetPath = fileURLToPath(targetUri);
    } catch {
      return { kind: "none" };
    }
    const rel = path.relative(this.root, targetPath).split(path.sep).join("/");
    if (rel.startsWith("..") || path.isAbsolute(rel) || rel.split("/").some((seg) => seg === ".venv" || seg === "venv" || seg === "site-packages")) return { kind: "external" };
    return { kind: "internal", path: rel, line: start.line + 1 };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.open.clear();
    if (client) await client.close();
  }
}

export interface PreciseFileResult {
  edges: CallEdge[];
  /** 这个文件里被 pyright 解决（含定义在仓库外）的调用点键 `line:col`。 */
  resolvedKeys: Set<string>;
  externalDefinitions: number;
  attempted: number;
}

const UPGRADABLE = new Set(["needs-types", "unknown-name", "inherited"]);

/** 对一个文件里语法层解不到的调用做精确解析。 */
export async function preciseForFile(session: PyrightSession, file: string, text: string, unresolved: UnresolvedCall[], symbolsByFile: Map<string, SymbolRecord[]>): Promise<PreciseFileResult> {
  const result: PreciseFileResult = { edges: [], resolvedKeys: new Set(), externalDefinitions: 0, attempted: 0 };
  const candidates = unresolved.filter((u) => u.path === file && UPGRADABLE.has(u.kind));
  if (!candidates.length) return result;
  await session.sync(file, text);
  const defAt = (p: string, line: number): SymbolRecord | undefined => {
    let best: SymbolRecord | undefined;
    for (const s of symbolsByFile.get(p) ?? []) {
      if (s.startLine <= line && line <= s.endLine && (!best || s.startLine >= best.startLine)) best = s;
    }
    return best;
  };
  for (const u of candidates) {
    result.attempted++;
    const def = await session.definition(file, u.line, u.col);
    if (def.kind === "none") continue;
    if (def.kind === "external") {
      result.externalDefinitions++;
      result.resolvedKeys.add(`${u.line}:${u.col}`);
      continue;
    }
    const target = defAt(def.path, def.line);
    if (!target || target.id === u.from) continue;
    result.edges.push({ from: u.from, to: target.id, evidence: { path: u.path, line: u.line, note: u.callee }, resolution: "pyright" });
    result.resolvedKeys.add(`${u.line}:${u.col}`);
  }
  return result;
}

export interface PreciseResult {
  edges: CallEdge[];
  stillUnresolved: UnresolvedCall[];
  externalDefinitions: number;
  attempted: number;
  skipped: string | null;
  elapsedMs: number;
}

/** 一次性版本：开会话、全部文件跑一遍、关会话。 */
export async function resolveWithPyright(root: string, unresolved: UnresolvedCall[], symbols: SymbolRecord[], contents: Map<string, string>): Promise<PreciseResult> {
  const started = Date.now();
  if (!PyrightSession.available()) return { edges: [], stillUnresolved: unresolved, externalDefinitions: 0, attempted: 0, skipped: "未安装 pyright（npm install pyright）", elapsedMs: 0 };
  const session = new PyrightSession(root);
  const symbolsByFile = new Map<string, SymbolRecord[]>();
  for (const s of symbols) symbolsByFile.set(s.path, [...(symbolsByFile.get(s.path) ?? []), s]);
  const files = [...new Set(unresolved.filter((u) => UPGRADABLE.has(u.kind) && u.path.endsWith(".py")).map((u) => u.path))];
  const edges: CallEdge[] = [];
  const resolved = new Map<string, Set<string>>();
  let external = 0;
  let attempted = 0;
  try {
    for (const file of files) {
      const text = contents.get(file);
      if (text === undefined) continue;
      const r = await preciseForFile(session, file, text, unresolved, symbolsByFile);
      edges.push(...r.edges);
      resolved.set(file, r.resolvedKeys);
      external += r.externalDefinitions;
      attempted += r.attempted;
    }
  } finally {
    await session.close();
  }
  const still = unresolved.filter((u) => !resolved.get(u.path)?.has(`${u.line}:${u.col}`));
  return { edges, stillUnresolved: still, externalDefinitions: external, attempted, skipped: null, elapsedMs: Date.now() - started };
}
