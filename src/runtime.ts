import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { Indexer, type IndexOptions, type IndexResult } from "./indexer.ts";
import { readOverlay } from "./config.ts";
import { isExcluded, globToRegExp } from "./files.ts";
import { readHistory } from "./history.ts";
import { readBaseline, diffSinceBaseline, setBaseline, type DiffResult } from "./baseline.ts";
import { assembleSnapshot, readSource, writeSnapshotJson, type Snapshot } from "./snapshot.ts";
import { writeFacts } from "./store.ts";
import { ActivityLog, hookToEvents, type HookPayload } from "./activity.ts";
import type { CommitRecord } from "./types.ts";

export interface RuntimeOptions extends IndexOptions {
  stateDir: string;
  maxCommits?: number;
  /** 文件变化后等待多久再重算（合并连续改动）。 */
  debounceMs?: number;
  log?: (line: string) => void;
}

export interface UpdateMessage {
  at: string;
  reason: "initial" | "files" | "git" | "hook" | "manual" | "refine";
  changed: string[];
  elapsedMs: number;
  violations: number;
  files: number;
}

/** 运行时：监听仓库，增量重算，向画布推送。 */
export class Runtime {
  readonly indexer: Indexer;
  readonly activity: ActivityLog;
  snapshot: Snapshot | null = null;
  private commits: CommitRecord[] = [];
  private watcher: fs.FSWatcher | null = null;
  private pending = new Set<string>();
  private gitChanged = false;
  private pendingReason: UpdateMessage["reason"] = "files";
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private readonly clients = new Set<http.ServerResponse>();
  private readonly excludes: RegExp[];
  private readonly log: (line: string) => void;
  readonly root: string;
  readonly options: RuntimeOptions;

  constructor(root: string, options: RuntimeOptions) {
    this.root = root;
    this.options = options;
    this.indexer = new Indexer(root, options);
    this.activity = new ActivityLog(options.stateDir);
    this.excludes = readOverlay(root, options.overlayFile).exclude.map(globToRegExp);
    this.log = options.log ?? ((line) => process.stdout.write(line + "\n"));
  }

  /** 首次全量，然后开始监听。 */
  async start(): Promise<void> {
    await this.cycle("initial");
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
        if (typeof filename !== "string" || !filename) return;
        this.onFsEvent(filename.split(path.sep).join("/"));
      });
      this.watcher.on("error", (error) => this.log(`监听出错：${error.message}`));
    } catch (error) {
      this.log(`无法监听目录：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async stop(): Promise<void> {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    for (const c of this.clients) c.end();
    this.clients.clear();
    await this.indexer.close();
  }

  /** 把一个文件系统事件归类：git 元数据、源码、忽略。 */
  classify(rel: string): "git" | "file" | "ignore" {
    if (rel === ".git" || rel.startsWith(".git/")) {
      const inner = rel.slice(5);
      // 不监听 .git/index：git status 本身会刷新它，会把自己触发成死循环；提交看 HEAD、refs、logs/HEAD 就够。
      if (inner === "HEAD" || inner === "ORIG_HEAD" || inner === "packed-refs" || inner.startsWith("refs/") || inner === "logs/HEAD") return "git";
      return "ignore";
    }
    // 标准任务目录在 .workbench 里，索引器不读它，但它变了要重算任务。
    if (rel.startsWith(".workbench/tasks/")) return "file";
    if (isExcluded(rel, this.excludes)) return "ignore";
    return "file";
  }

  onFsEvent(rel: string): void {
    const kind = this.classify(rel);
    if (kind === "ignore") return;
    if (kind === "git") this.gitChanged = true;
    else this.pending.add(rel);
    this.schedule(this.options.debounceMs ?? 250);
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  private async flush(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    const reason = this.pendingReason;
    this.pendingReason = "files";
    this.running = this.cycle(reason).catch((error: unknown) => {
      this.log(`重算失败：${error instanceof Error ? error.message : String(error)}`);
      this.activity.record({ at: new Date().toISOString(), source: "system", kind: "error", text: `重算失败：${error instanceof Error ? error.message : String(error)}` });
    });
    await this.running;
    this.running = null;
    if (this.rerun || this.pending.size || this.gitChanged) {
      this.rerun = false;
      this.schedule(50);
    } else if (this.indexer.hasDeferred()) {
      // 先快后准：导入方的精确层放到紧随其后的一轮。
      this.pendingReason = "refine";
      this.schedule(100);
    }
  }

  /** 一轮重算：索引（增量）→ 历史（有 git 变化时）→ 基线差异 → 快照 → 推送。 */
  async cycle(reason: UpdateMessage["reason"]): Promise<void> {
    const started = Date.now();
    const pendingPaths = [...this.pending];
    this.pending.clear();
    const gitChanged = this.gitChanged || reason === "initial";
    this.gitChanged = false;
    const result: IndexResult = await this.indexer.run({ deferImporters: reason !== "initial" && reason !== "refine" });
    if (gitChanged || !this.commits.length) {
      this.commits = await readHistory(this.root, { stageTag: result.overlay.stage_tag, ...(this.options.maxCommits ? { max: this.options.maxCommits } : {}) });
    }
    const source = await readSource(this.root);
    let baseline: DiffResult | undefined;
    const b = readBaseline(this.options.stateDir);
    if (b && source.commit) {
      try {
        baseline = await diffSinceBaseline(this.root, b);
      } catch {
        baseline = undefined;
      }
    }
    const changed = result.changedFiles.length ? result.changedFiles : pendingPaths;
    const elapsedMs = Date.now() - started;
    if (reason === "refine") {
      this.activity.record({ at: new Date().toISOString(), source: "system", kind: "refine", text: `细化：导入方的精确层已更新，${(elapsedMs / 1000).toFixed(1)} 秒` });
    } else if (reason !== "initial") {
      this.activity.record({
        at: new Date().toISOString(),
        source: gitChanged && !changed.length ? "git" : "watcher",
        kind: "recompute",
        text: changed.length ? `重算 ${changed.length} 个文件（${changed.slice(0, 3).join("、")}${changed.length > 3 ? "…" : ""}），${(elapsedMs / 1000).toFixed(1)} 秒` : `git 变化，刷新历史与基线，${(elapsedMs / 1000).toFixed(1)} 秒`,
      });
    }
    this.snapshot = assembleSnapshot({
      root: this.root,
      result,
      commits: this.commits,
      source,
      ...(baseline ? { baseline } : {}),
      activity: { events: this.activity.recent(200), touched: this.activity.touched() },
      standardTasksDir: path.join(this.options.stateDir, "tasks"),
    });
    writeSnapshotJson(this.options.stateDir, this.snapshot);
    const message: UpdateMessage = { at: this.snapshot.generatedAt, reason, changed, elapsedMs, violations: result.violations.length, files: result.files.length };
    this.broadcast("update", message);
    this.log(`[${reason}] ${changed.length ? `${changed.length} 个文件` : "无文件变化"} · 违规 ${result.violations.length} · ${(elapsedMs / 1000).toFixed(1)} 秒`);
    const snapshot = this.snapshot;
    setImmediate(() => {
      try {
        writeFacts(path.join(this.options.stateDir, "facts.sqlite"), snapshot);
      } catch (error) {
        this.log(`写 sqlite 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /** 处理 Claude Code hook。 */
  async hook(payload: HookPayload): Promise<{ accepted: boolean; detail: string }> {
    const outcome = hookToEvents(this.root, payload);
    if (outcome.ignored) return { accepted: false, detail: outcome.ignored };
    for (const ev of outcome.events) this.broadcast("activity", this.activity.record(ev));
    if (outcome.sessionStart) {
      try {
        const b = await setBaseline(this.root, this.options.stateDir, `会话 ${outcome.sessionStart.session} 开始`);
        this.broadcast("activity", this.activity.record({ at: new Date().toISOString(), source: "hook", kind: "baseline", session: outcome.sessionStart.session, text: `基线记为 ${b.commit.slice(0, 9)}` }));
      } catch (error) {
        this.broadcast("activity", this.activity.record({ at: new Date().toISOString(), source: "system", kind: "error", text: `记基线失败：${error instanceof Error ? error.message : String(error)}` }));
      }
      this.pendingReason = "hook";
      this.schedule(0);
    }
    if (outcome.touched.length) {
      for (const p of outcome.touched) this.pending.add(p);
      this.pendingReason = "hook";
      this.schedule(50);
    }
    return { accepted: true, detail: `${outcome.events.length} 个事件` };
  }

  /** SSE 客户端。 */
  subscribe(res: http.ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write("retry: 2000\n\n");
    this.clients.add(res);
    const keepalive = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch {
        /* ignore */
      }
    }, 20_000);
    res.on("close", () => {
      clearInterval(keepalive);
      this.clients.delete(res);
    });
  }

  broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) {
      try {
        c.write(payload);
      } catch {
        this.clients.delete(c);
      }
    }
  }
}
