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
import { AutoTester } from "./autotest.ts";
import { guessPythonPath } from "./pyright.ts";
import type { CommitRecord } from "./types.ts";

export interface RuntimeOptions extends IndexOptions {
  stateDir: string;
  maxCommits?: number;
  /** 文件变化后等待多久再重算（合并连续改动）。 */
  debounceMs?: number;
  /** 改了文件后自动只跑相关测试；缺省看 overlay 的 test_results.auto（缺省开）。 */
  autoTest?: boolean;
  log?: (line: string) => void;
}

export interface UpdateMessage {
  at: string;
  reason: "initial" | "files" | "git" | "hook" | "manual" | "refine" | "tests" | "annotations";
  changed: string[];
  elapsedMs: number;
  violations: number;
  files: number;
}

/** 测试结果目录里只认顶层写好的 .xml / .json（junit.xml、coverage.json、results.json）；自动跑过程中的 partial/ 和 .tmp 不算。 */
const TEST_RESULT_FILE = /^\.workbench\/test-results\/[^/]+\.(?:xml|json)$/;
const RESULT_FILE_NAME = /^[^/\\]+\.(?:xml|json)$/;

/** 运行时：监听仓库，增量重算，向画布推送。 */
export class Runtime {
  readonly indexer: Indexer;
  readonly activity: ActivityLog;
  readonly autoTester: AutoTester;
  snapshot: Snapshot | null = null;
  private commits: CommitRecord[] = [];
  private watcher: fs.FSWatcher | null = null;
  private resultsWatcher: fs.FSWatcher | null = null;
  private pending = new Set<string>();
  private gitChanged = false;
  /** 测试结果文件变了（glassbox test 全量跑完，或自动跑合并出了 results.json）。 */
  private testsChanged = false;
  /** 标注文件变了（AI 交了一批，或人手改了 annotations.yaml）。 */
  private annotationsChanged = false;
  /** 服务自己刚写完 annotations.yaml 的时间：紧随其后的监听事件是同一件事。 */
  private annotationsWrittenAt = 0;
  private annotationsWatcher: fs.FSWatcher | null = null;
  /** 自动跑刚写完 results.json 的时间：直接通知已经安排了重算，紧随其后的监听事件是同一件事，不再多算一轮。 */
  private resultsWrittenAt = 0;
  private pendingReason: UpdateMessage["reason"] = "files";
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private readonly clients = new Set<http.ServerResponse>();
  private readonly excludes: RegExp[];
  private readonly keepDotDirs: Set<string>;
  private readonly log: (line: string) => void;
  readonly root: string;
  readonly options: RuntimeOptions;

  constructor(root: string, options: RuntimeOptions) {
    this.root = root;
    this.options = options;
    this.indexer = new Indexer(root, options);
    this.activity = new ActivityLog(options.stateDir);
    const overlay = readOverlay(root, options.overlayFile);
    this.excludes = overlay.exclude.map(globToRegExp);
    this.keepDotDirs = new Set(overlay.keep_dot_dirs ?? []);
    this.log = options.log ?? ((line) => process.stdout.write(line + "\n"));
    const tr = overlay.test_results ?? {};
    const python = tr.python ? path.resolve(root, tr.python) : guessPythonPath(root);
    this.autoTester = new AutoTester(
      root,
      {
        stateDir: options.stateDir,
        ...(python ? { python } : {}),
        enabled: options.autoTest ?? tr.auto ?? true,
        ...(tr.debounce_ms !== undefined ? { debounceMs: tr.debounce_ms } : {}),
        log: (l) => this.log(`[pytest] ${l}`),
      },
      {
        tests: () => this.snapshot?.tests,
        known: () => new Set((this.snapshot?.files ?? []).map((f) => f.path)),
        onEvent: (ev) => this.broadcast("activity", this.activity.record(ev)),
        onState: (s) => this.broadcast("autotest", s),
        onResults: () => {
          this.resultsWrittenAt = Date.now();
          this.testsChanged = true;
          this.schedule(0);
        },
      },
    );
  }

  /** 首次全量，然后开始监听。 */
  async start(): Promise<void> {
    const auto = await this.autoTester.probe();
    this.log(auto.enabled ? `自动跑相关测试：开（${auto.python}）` : `自动跑相关测试：关（${auto.why}）`);
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
    // 状态目录在仓库外时，单独盯着它的 test-results（glassbox test 往那里写）。
    const results = path.join(this.options.stateDir, "test-results");
    const relToRoot = path.relative(this.root, results);
    const outside = relToRoot.startsWith("..") || path.isAbsolute(relToRoot);
    if (outside) {
      fs.mkdirSync(results, { recursive: true });
      try {
        this.resultsWatcher = fs.watch(results, (_event, filename) => {
          if (typeof filename === "string" && RESULT_FILE_NAME.test(filename) && !this.ownResultsEvent(filename)) {
            this.testsChanged = true;
            this.schedule(this.options.debounceMs ?? 250);
          }
        });
        this.resultsWatcher.on("error", () => undefined);
      } catch {
        /* 盯不住也不影响 */
      }
      // 状态目录在仓库外时，标注文件也要单独盯；只认 annotations.yaml，状态目录里别的文件（快照、事件日志）每轮都在写。
      try {
        this.annotationsWatcher = fs.watch(this.options.stateDir, (_event, filename) => {
          if (filename === "annotations.yaml" && Date.now() - this.annotationsWrittenAt >= 3000) {
            this.annotationsChanged = true;
            this.schedule(this.options.debounceMs ?? 250);
          }
        });
        this.annotationsWatcher.on("error", () => undefined);
      } catch {
        /* 同上 */
      }
    }
  }

  async stop(): Promise<void> {
    this.watcher?.close();
    this.watcher = null;
    this.resultsWatcher?.close();
    this.resultsWatcher = null;
    this.annotationsWatcher?.close();
    this.annotationsWatcher = null;
    this.autoTester.stop();
    if (this.timer) clearTimeout(this.timer);
    for (const c of this.clients) c.end();
    this.clients.clear();
    await this.indexer.close();
  }

  /** 把一个文件系统事件归类：git 元数据、源码、测试结果、忽略。 */
  classify(rel: string): "git" | "file" | "tests" | "ignore" | "annotations" {
    if (rel === ".git" || rel.startsWith(".git/")) {
      const inner = rel.slice(5);
      // 不监听 .git/index：git status 本身会刷新它，会把自己触发成死循环；提交看 HEAD、refs、logs/HEAD 就够。
      if (inner === "HEAD" || inner === "ORIG_HEAD" || inner === "packed-refs" || inner.startsWith("refs/") || inner === "logs/HEAD") return "git";
      return "ignore";
    }
    // 标准任务目录在 .workbench 里，索引器不读它，但它变了要重算任务。
    if (rel.startsWith(".workbench/tasks/")) return "file";
    // 人话标注：索引器不读，但变了要重算状态。
    if (rel === ".workbench/annotations.yaml") return "annotations";
    // 测试结果：索引器不读，但变了要重读；自动跑过程中的 partial/junit.xml 和 .tmp 不算，不然每次自动跑都多一轮「重算 1 个文件」。
    if (rel.startsWith(".workbench/test-results/")) return TEST_RESULT_FILE.test(rel) ? "tests" : "ignore";
    if (isExcluded(rel, this.excludes, this.keepDotDirs)) return "ignore";
    return "file";
  }

  onFsEvent(rel: string): void {
    const kind = this.classify(rel);
    if (kind === "ignore") return;
    if (kind === "tests" && this.ownResultsEvent(rel)) return;
    if (kind === "annotations" && Date.now() - this.annotationsWrittenAt < 3000) return;
    if (kind === "git") this.gitChanged = true;
    else if (kind === "tests") this.testsChanged = true;
    else if (kind === "annotations") this.annotationsChanged = true;
    else this.pending.add(rel);
    this.schedule(this.options.debounceMs ?? 250);
  }

  /** 这个事件是不是自动跑自己刚写的 results.json（3 秒内；直接通知已经安排了那一轮）。 */
  private ownResultsEvent(file: string): boolean {
    return /(^|\/)results\.json$/.test(file) && Date.now() - this.resultsWrittenAt < 3000;
  }

  /** 攒着还没重算的东西（诊断、测试用）。 */
  queued(): { files: string[]; git: boolean; tests: boolean } {
    return { files: [...this.pending].sort(), git: this.gitChanged, tests: this.testsChanged };
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
    // 只有测试结果变了、没有别的变化，这一轮才叫 tests；否则按文件 / hook 算，测试结果的变化在 cycle 里另记一条。
    const quiet = this.pendingReason === "files" && !this.pending.size && !this.gitChanged;
    const reason = quiet && this.testsChanged ? "tests" : quiet && this.annotationsChanged ? "annotations" : this.pendingReason;
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
    const testsChanged = this.testsChanged;
    this.testsChanged = false;
    const annotationsChanged = this.annotationsChanged;
    this.annotationsChanged = false;
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
    } else if (reason !== "initial" && reason !== "tests" && reason !== "annotations") {
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
      stateDir: this.options.stateDir,
      autoTest: this.autoTester.state(),
    });
    if (annotationsChanged) {
      const a = this.snapshot.annotations;
      const text = a ? `人话标注更新：${a.summary.total} 条，${a.summary.stale} 条过时、${a.summary.orphan} 条没对象；还有 ${a.summary.todoDirs} 个目录、${a.summary.todoFiles} 个文件没标` : "标注文件变了";
      this.broadcast("activity", this.activity.record({ at: new Date().toISOString(), source: "system", kind: "annotations", text }));
    }
    if (testsChanged) {
      // 结果文件变了（glassbox test 全量跑，或自动跑的相关测试合并进来了）。
      const r = this.snapshot.tests?.run;
      const p = r?.partial;
      const fresh = p && Date.now() - Date.parse(p.at) < 60_000;
      const text = !r
        ? "测试结果文件变了"
        : fresh
          ? `自动跑了 ${p.ran} 个相关测试：通过 ${p.passed}、失败 ${p.failed}、跳过 ${p.skipped}，${(p.elapsedMs / 1000).toFixed(1)} 秒 → 总计 ${r.passed} 通过、${r.failed + r.errors} 失败、${r.skipped} 跳过`
          : `测试结果更新：${r.passed} 通过、${r.failed + r.errors} 失败、${r.skipped} 跳过`;
      this.broadcast("activity", this.activity.record({ at: new Date().toISOString(), source: "system", kind: "tests", text }));
    }
    writeSnapshotJson(this.options.stateDir, this.snapshot);
    const message: UpdateMessage = { at: this.snapshot.generatedAt, reason, changed, elapsedMs, violations: result.violations.length, files: result.files.length };
    this.broadcast("update", message);
    this.log(`[${reason}] ${changed.length ? `${changed.length} 个文件` : "无文件变化"} · 违规 ${result.violations.length} · ${(elapsedMs / 1000).toFixed(1)} 秒`);
    // 源码变了（监听到的或 hook 报的）→ 只跑和它们相关的测试。
    if ((reason === "files" || reason === "hook") && result.changedFiles.length) this.autoTester.notice(result.changedFiles);
    const snapshot = this.snapshot;
    setImmediate(() => {
      try {
        writeFacts(path.join(this.options.stateDir, "facts.sqlite"), snapshot);
      } catch (error) {
        this.log(`写 sqlite 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /** 服务自己刚把一批标注写进 annotations.yaml：马上重算一轮，紧随其后的监听事件不再多算。 */
  annotationsWritten(): void {
    this.annotationsWrittenAt = Date.now();
    this.annotationsChanged = true;
    this.schedule(0);
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
    // Claude 本轮结束：攒着的相关测试不等了，马上跑。
    if (payload.hook_event_name === "Stop") this.autoTester.flushNow();
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
