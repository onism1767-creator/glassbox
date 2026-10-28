/**
 * `glassbox annotate …`：标注协议的命令行入口。服务开着就走 HTTP（秒回），没开就本地索引一次。
 * 协议本身和 AI 工具无关：任何能跑命令、读写 JSON 的东西都能写标注。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexRepository, type IndexOptions } from "./index.ts";
import { annotationSnapshot, annotationTodo, applyAnnotations, lineCounter, readAnnotations, HOW_TO, type AnnotationSnapshot, type ApplyResult, type NodeWorld, type TodoItem, type TodoOptions } from "./annotations.ts";

export interface AnnotateOptions extends IndexOptions {
  stateDir: string;
  port: number;
  noServer: boolean;
  json: boolean;
  todo: TodoOptions;
  /** set：批文件；没有就读 stdin。 */
  input?: string;
  author: string;
  staleOnly: boolean;
  out: (text: string) => void;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    try {
      p = fs.realpathSync(p);
    } catch {
      /* 保持原样 */
    }
    return p.split("\\").join("/").replace(/\/+$/, "").toLowerCase();
  };
  return norm(a) === norm(b);
}

/** 服务开着且看的是同一个仓库，就用它。 */
async function server(root: string, port: number): Promise<string | null> {
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${base}/api/annotations`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = (await res.json()) as { root?: string };
    return body.root && samePath(body.root, root) ? base : null;
  } catch {
    return null;
  }
}

async function localWorld(root: string, options: IndexOptions): Promise<NodeWorld> {
  const r = await indexRepository(root, options);
  return { files: r.files, symbols: r.symbols, edges: r.edges, layers: r.rules.layers };
}

function short(hash: string): string {
  return hash.slice(0, 12);
}

export function formatTodo(items: TodoItem[]): string {
  if (!items.length) return "画布上的目录和文件都有新鲜的标注，没有要写的。\n";
  const lines = [`还没标或已过时的节点 ${items.length} 个（先目录，再被 import 最多的文件）：`];
  for (const it of items) {
    const why = it.why === "stale" ? `（过时，旧标注「${it.previous?.name ?? ""}」：${it.previous?.role ?? ""}）` : "";
    if (it.kind === "dir") {
      lines.push(`[目录] ${it.node}  ${it.fileCount} 个文件${it.layer !== undefined ? ` · 第 ${it.layer} 层` : ""}  hash ${short(it.hash)}${why}`);
      lines.push(`       ${(it.files ?? []).slice(0, 12).join("、")}${(it.fileCount ?? 0) > 12 ? "…" : ""}`);
    } else if (it.kind === "file") {
      const syms = (it.symbols ?? []).slice(0, 8).map((s) => `${s.kind} ${s.qualified} ${s.startLine}–${s.endLine}`).join("、");
      lines.push(`[文件] ${it.node}  被 import ${it.importedBy} 次${it.dirName ? ` · 目录叫「${it.dirName}」` : ""}  hash ${short(it.hash)}${why}`);
      if (syms) lines.push(`       ${syms}${(it.symbols?.length ?? 0) > 8 ? "…" : ""}`);
      if (it.importsOut?.length) lines.push(`       import 了 ${it.importsOut.slice(0, 6).join("、")}${it.importsOut.length > 6 ? "…" : ""}`);
    } else {
      lines.push(`[函数或类] ${it.node}  ${it.symbol?.kind} 第 ${it.symbol?.startLine}–${it.symbol?.endLine} 行  hash ${short(it.hash)}${why}`);
    }
  }
  lines.push("");
  lines.push("写法：JSON 数组，每条 { \"node\", \"name\"（≤40 字的人话名）, \"role\"（≤200 字的一句话职责）, \"basis\": [{ \"path\", \"line\" }], \"hash\" }。");
  lines.push("依据必须落在这个节点里（文件就是它自己，目录是它里面的文件，函数或类是它的行号范围）；hash 原样抄回，代码变了会退回让你重看。");
  lines.push("然后：glassbox annotate set <仓库> --file 批.json [--author 名字]");
  return lines.join("\n") + "\n";
}

export function formatApply(r: { accepted: string[]; rejected: ApplyResult["rejected"]; total: number; file: string }): string {
  const lines = [`收下 ${r.accepted.length} 条，退回 ${r.rejected.length} 条；标注文件现在共 ${r.total} 条（${r.file}）`];
  for (const n of r.accepted) lines.push(`  ✓ ${n}`);
  for (const x of r.rejected) lines.push(`  ✗ 第 ${x.index + 1} 条${x.node ? ` ${x.node}` : ""}：${x.reason}`);
  return lines.join("\n") + "\n";
}

export function formatShow(a: AnnotationSnapshot, staleOnly: boolean): string {
  const s = a.summary;
  const lines = [`人话标注 ${s.total} 条：${s.fresh} 条和代码一致、${s.stale} 条过时、${s.orphan} 条没对象；还有 ${s.todoDirs} 个目录、${s.todoFiles} 个文件没标（${a.source}）`];
  for (const v of a.items) {
    if (staleOnly && v.status === "fresh") continue;
    const mark = v.status === "fresh" ? "✓" : v.status === "stale" ? "过时" : "没对象";
    lines.push(`  ${mark} ${v.node}  ${v.name}：${v.role}  （${v.author}，${v.at.slice(0, 16).replace("T", " ")}）`);
  }
  return lines.join("\n") + "\n";
}

export async function annotate(sub: string, root: string, o: AnnotateOptions): Promise<void> {
  const indexOptions: IndexOptions = { ...(o.overlayFile ? { overlayFile: o.overlayFile } : {}), ...(o.precise === false ? { precise: false } : {}) };
  const base = o.noServer ? null : await server(root, o.port);
  if (sub === "todo") {
    let items: TodoItem[];
    if (base) {
      const q = new URLSearchParams();
      if (o.todo.kind) q.set("kind", o.todo.kind);
      if (o.todo.dir) q.set("dir", o.todo.dir);
      if (o.todo.file) q.set("file", o.todo.file);
      if (o.todo.limit) q.set("limit", String(o.todo.limit));
      items = ((await (await fetch(`${base}/api/annotations/todo?${q}`)).json()) as { items: TodoItem[] }).items;
    } else {
      items = annotationTodo(await localWorld(root, indexOptions), readAnnotations(o.stateDir).items, o.todo);
    }
    o.out(o.json ? JSON.stringify({ via: base ?? "local", items, howTo: HOW_TO }, null, 1) + "\n" : formatTodo(items));
    return;
  }
  if (sub === "set") {
    const text = o.input ? fs.readFileSync(o.input, "utf8") : fs.readFileSync(0, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`批文件不是 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
    let report: { accepted: string[]; rejected: ApplyResult["rejected"]; total: number; file: string };
    if (base) {
      const items = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown[] })?.items ?? [];
      const res = await fetch(`${base}/api/annotations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items, author: o.author }) });
      if (!res.ok) throw new Error(`服务拒绝：${res.status} ${await res.text()}`);
      report = (await res.json()) as typeof report;
    } else {
      const r = applyAnnotations(o.stateDir, await localWorld(root, indexOptions), parsed, { lineCount: lineCounter(root), author: o.author, now: new Date().toISOString() });
      report = { accepted: r.accepted.map((a) => a.node), rejected: r.rejected, total: r.total, file: r.file };
    }
    o.out(o.json ? JSON.stringify({ via: base ?? "local", ...report }, null, 1) + "\n" : formatApply(report));
    if (report.rejected.length && !report.accepted.length) process.exitCode = 1;
    return;
  }
  if (sub === "show") {
    let a: AnnotationSnapshot;
    if (base) a = (await (await fetch(`${base}/api/annotations`)).json()) as AnnotationSnapshot;
    else a = annotationSnapshot(o.stateDir, await localWorld(root, indexOptions));
    o.out(o.json ? JSON.stringify(a, null, 1) + "\n" : formatShow(a, o.staleOnly));
    return;
  }
  if (sub === "skill") {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "glassbox-annotate", "SKILL.md");
    const dst = path.join(root, ".claude", "skills", "glassbox-annotate", "SKILL.md");
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    o.out(`已装到 ${dst}\n新开的 Claude Code 会话里说"给画布写标注"就会用它。\n`);
    return;
  }
  throw new Error("用法: glassbox annotate todo|set|show|skill [仓库]");
}
