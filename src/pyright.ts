/**
 * 精确层：驱动 pyright 语言服务器，对语法层解不到的调用做「跳到定义」。
 * pyright 是纯 JS、Windows 可用；scip-python 0.6.7 在 Windows 启动即崩，故不用。
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

  private exited = false;

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
      // 服务器发来的请求：配置给设置，其余一律回 null。
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

export interface PreciseResult {
  edges: CallEdge[];
  stillUnresolved: UnresolvedCall[];
  /** 定义在仓库之外（第三方库、标准库）的调用数。 */
  externalDefinitions: number;
  attempted: number;
  skipped: string | null;
  elapsedMs: number;
}

const UPGRADABLE = new Set(["needs-types", "unknown-name", "inherited"]);

/** 用 pyright 的「跳到定义」把语法层解不到的 Python 调用升级成调用边。 */
export async function resolveWithPyright(root: string, unresolved: UnresolvedCall[], symbols: SymbolRecord[], contents: Map<string, string>): Promise<PreciseResult> {
  const started = Date.now();
  const entry = pyrightServerEntry();
  const candidates = unresolved.filter((u) => UPGRADABLE.has(u.kind) && u.path.endsWith(".py"));
  const rest = unresolved.filter((u) => !candidates.includes(u));
  if (!entry) return { edges: [], stillUnresolved: unresolved, externalDefinitions: 0, attempted: 0, skipped: "未安装 pyright（npm install pyright）", elapsedMs: 0 };
  if (!candidates.length) return { edges: [], stillUnresolved: unresolved, externalDefinitions: 0, attempted: 0, skipped: null, elapsedMs: 0 };

  const pythonPath = guessPythonPath(root);
  const settings = { pythonPath, analysis: { autoSearchPaths: true, diagnosticMode: "openFilesOnly", typeCheckingMode: "off", logLevel: "Error" } };
  const client = new LspClient(entry, root, settings);
  const rootUri = pathToFileURL(root).href;
  const byFile = new Map<string, SymbolRecord[]>();
  for (const s of symbols) {
    const list = byFile.get(s.path) ?? [];
    list.push(s);
    byFile.set(s.path, list);
  }
  const defAt = (file: string, line: number): SymbolRecord | undefined => {
    let best: SymbolRecord | undefined;
    for (const s of byFile.get(file) ?? []) {
      if (s.startLine <= line && line <= s.endLine && (!best || s.startLine >= best.startLine)) best = s;
    }
    return best;
  };
  const edges: CallEdge[] = [];
  const still: UnresolvedCall[] = [];
  let external = 0;
  try {
    await client.request("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: { textDocument: { definition: { linkSupport: true } }, workspace: { configuration: true } },
      workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
      initializationOptions: {},
    }, 120_000);
    client.notify("initialized", {});
    client.notify("workspace/didChangeConfiguration", { settings: { python: settings } });
    const grouped = new Map<string, UnresolvedCall[]>();
    for (const u of candidates) {
      const list = grouped.get(u.path) ?? [];
      list.push(u);
      grouped.set(u.path, list);
    }
    for (const [file, calls] of grouped) {
      const text = contents.get(file) ?? "";
      const uri = pathToFileURL(path.join(root, file)).href;
      client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "python", version: 1, text } });
      for (const u of calls) {
        let locations: (Location | LocationLink)[] | Location | null = null;
        try {
          locations = await client.request("textDocument/definition", { textDocument: { uri }, position: { line: u.line - 1, character: u.col } }, 30_000);
        } catch {
          locations = null;
        }
        const list = Array.isArray(locations) ? locations : locations ? [locations] : [];
        const first = list[0];
        if (!first) {
          still.push(u);
          continue;
        }
        const targetUri = "targetUri" in first ? first.targetUri : first.uri;
        const start = "targetUri" in first ? (first.targetSelectionRange ?? first.targetRange).start : first.range.start;
        let targetPath: string;
        try {
          targetPath = fileURLToPath(targetUri);
        } catch {
          still.push(u);
          continue;
        }
        const rel = path.relative(root, targetPath).split(path.sep).join("/");
        if (rel.startsWith("..") || path.isAbsolute(rel) || rel.split("/").some((seg) => seg === ".venv" || seg === "venv" || seg === "site-packages")) {
          external++;
          continue;
        }
        const target = defAt(rel, start.line + 1);
        if (!target || target.id === u.from) {
          still.push({ ...u, reason: `${u.reason}；pyright 指向 ${rel}:${start.line + 1}，但那里不是函数或类定义` });
          continue;
        }
        edges.push({ from: u.from, to: target.id, evidence: { path: u.path, line: u.line, note: u.callee }, resolution: "pyright" });
      }
      client.notify("textDocument/didClose", { textDocument: { uri } });
    }
  } finally {
    await client.close();
  }
  return { edges, stillUnresolved: [...rest, ...still], externalDefinitions: external, attempted: candidates.length, skipped: null, elapsedMs: Date.now() - started };
}
