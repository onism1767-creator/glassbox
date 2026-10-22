import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Runtime, type RuntimeOptions } from "./runtime.ts";
import type { HookPayload } from "./activity.ts";

const webDist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export interface ServeOptions extends RuntimeOptions {
  port: number;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, limit = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export async function serve(root: string, options: ServeOptions): Promise<{ server: http.Server; runtime: Runtime }> {
  const runtime = new Runtime(root, options);
  process.stdout.write("首次索引…\n");
  await runtime.start();
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => json(res, 500, { error: error instanceof Error ? error.message : String(error) }));
  });
  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/hook") {
      if (req.method !== "POST") return json(res, 405, { error: "POST" });
      let payload: HookPayload;
      try {
        payload = JSON.parse((await readBody(req)) || "{}") as HookPayload;
      } catch {
        return json(res, 400, { error: "不是 JSON" });
      }
      const result = await runtime.hook(payload);
      return json(res, 200, result);
    }
    if (req.method !== "GET") return json(res, 405, { error: "只支持 GET" });
    if (url.pathname === "/api/snapshot") {
      if (!runtime.snapshot) return json(res, 503, { error: "快照尚未生成" });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(runtime.snapshot));
      return;
    }
    if (url.pathname === "/api/stream") {
      runtime.subscribe(res);
      return;
    }
    if (url.pathname === "/api/activity") {
      const limit = Math.min(500, Number(url.searchParams.get("limit") ?? "100") || 100);
      return json(res, 200, { events: runtime.activity.recent(limit), touched: runtime.activity.touched() });
    }
    if (url.pathname === "/api/file") {
      const rel = url.searchParams.get("path") ?? "";
      const line = Math.max(1, Number(url.searchParams.get("line") ?? "1") || 1);
      const context = Math.min(40, Math.max(0, Number(url.searchParams.get("context") ?? "4") || 4));
      if (!rel || rel.includes("..") || path.isAbsolute(rel) || rel.includes("\0")) return json(res, 400, { error: "路径不合法" });
      const full = path.join(root, rel);
      if (!full.startsWith(root) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return json(res, 404, { error: "文件不存在" });
      if (fs.statSync(full).size > 2 * 1024 * 1024) return json(res, 413, { error: "文件太大" });
      const lines = fs.readFileSync(full, "utf8").split("\n");
      const from = Math.max(1, line - context);
      const to = Math.min(lines.length, line + context);
      return json(res, 200, { path: rel, from, lines: lines.slice(from - 1, to) });
    }
    let filePath = path.join(webDist, url.pathname === "/" ? "index.html" : url.pathname);
    if (!filePath.startsWith(webDist) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(webDist, "index.html");
    if (!fs.existsSync(filePath)) return json(res, 503, { error: "前端未构建：先运行 npm run web:build" });
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  }
  await new Promise<void>((resolve) => server.listen(options.port, "127.0.0.1", resolve));
  process.stdout.write(`glassbox · http://127.0.0.1:${options.port}\n仓库：${root}\n状态目录：${options.stateDir}\n监听中，改文件即重算；hook 端点 POST /api/hook\n`);
  const shutdown = (): void => {
    void runtime.stop().finally(() => {
      server.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { server, runtime };
}
