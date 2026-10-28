/**
 * 自动跑相关测试：改了哪个文件，就只跑和它相关的测试（覆盖率上下文 T0、测试文件 import 推断 T1、
 * 它本身是测试文件、conftest 影响整个目录），结果合并进上一次的测试结果，画布几秒内更新。
 */
import fs from "node:fs";
import path from "node:path";
import { parseJunit, type TestRun, type TestSnapshot, type TestCase, type AutoTestState, type PartialRun } from "./tests.ts";
import { runCommand, probeModule } from "./runtests.ts";
import type { ActivityEvent, Tier } from "./types.ts";

export interface SelectionItem {
  path: string;
  how: string;
  tier?: Tier;
  /** 传给 pytest 的参数：用例 id、测试文件或目录。 */
  args: string[];
}

export interface Selection {
  args: string[];
  granularity: "case" | "file";
  items: SelectionItem[];
  skipped: { path: string; why: string }[];
  /** 按上次结果估计这次会跑到的用例数。 */
  estimated: number;
}

const TEST_FILE = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/;

/** 去掉参数化后缀：tests/a.py::test_x[1] → tests/a.py::test_x。pytest 收到它会把所有参数都跑。 */
export function baseId(id: string): string {
  return id.replace(/\[.*\]$/, "");
}

function fileOfArg(arg: string): string {
  return arg.split("::")[0] ?? arg;
}

/** 一个用例在不在这次选择的范围里（用来决定合并时替换谁）。 */
export function inScope(c: TestCase, args: string[], dirs: Set<string>): boolean {
  if (args.includes(baseId(c.id))) return true;
  if (c.file) {
    if (args.includes(c.file)) return true;
    for (const d of dirs) if (d === "." || c.file.startsWith(d + "/")) return true;
  }
  return false;
}

export function selectTests(changed: string[], tests: TestSnapshot | undefined, options: { maxArgChars?: number; exists?: (p: string) => boolean } = {}): Selection {
  const exists = options.exists ?? (() => true);
  const items: SelectionItem[] = [];
  const skipped: Selection["skipped"] = [];
  const dirs = new Set<string>();
  const files = new Set<string>();
  const ids = new Set<string>();
  for (const p of [...new Set(changed)].sort()) {
    if (!p.endsWith(".py")) {
      skipped.push({ path: p, why: "不是 Python 文件" });
      continue;
    }
    const base = path.posix.basename(p);
    if (base === "conftest.py") {
      const dir = path.posix.dirname(p);
      if (!exists(dir)) {
        skipped.push({ path: p, why: "目录已不存在" });
        continue;
      }
      dirs.add(dir);
      items.push({ path: p, how: "conftest 影响整个目录", args: [dir] });
      continue;
    }
    if (TEST_FILE.test(p)) {
      if (!exists(p)) {
        skipped.push({ path: p, why: "测试文件已删除" });
        continue;
      }
      files.add(p);
      items.push({ path: p, how: "它本身是测试文件", args: [p] });
      continue;
    }
    const st = tests?.fileStatus[p];
    if (st && st.related.length) {
      const own = [...new Set(st.related.map(baseId))].sort();
      for (const id of own) ids.add(id);
      items.push({ path: p, how: st.tier === "T0" ? "覆盖率上下文说这些测试跑过它" : st.note ? "覆盖率上下文有歧义，同名测试模块的都算" : "测试文件 import 了它", tier: st.tier, args: own });
      continue;
    }
    skipped.push({ path: p, why: "还不知道哪些测试和它相关（没有覆盖率上下文，也没有测试文件 import 它）" });
  }
  // 已经整文件、整目录跑的，不再单列用例。
  const covered = (f: string) => files.has(f) || [...dirs].some((d) => d === "." || f.startsWith(d + "/"));
  let caseArgs = [...ids].filter((id) => !covered(fileOfArg(id)));
  const fileArgs = [...files].filter((f) => ![...dirs].some((d) => d === "." || f.startsWith(d + "/")));
  let granularity: Selection["granularity"] = "case";
  const max = options.maxArgChars ?? 12_000;
  if (caseArgs.join(" ").length > max) {
    // 命令行太长，退到按测试文件跑。
    caseArgs = [...new Set(caseArgs.map(fileOfArg))].sort().filter((f) => !covered(f));
    granularity = "file";
  }
  const args = [...dirs, ...fileArgs, ...caseArgs];
  const dirSet = new Set(dirs);
  const estimated = tests?.run ? tests.run.cases.filter((c) => inScope(c, args, dirSet)).length : 0;
  return { args, granularity, items, skipped, estimated };
}

/** 把这次只跑了一部分的结果合并进上一次的：范围内的用例换成新结果，范围外的保留。 */
export function mergeRuns(previous: TestRun | undefined, partial: TestRun, selection: Selection, meta: { changed: string[]; elapsedMs: number; exists?: (p: string) => boolean }): TestRun {
  const dirs = new Set(selection.args.filter((a) => !a.includes("::") && !a.endsWith(".py")));
  const exists = meta.exists ?? (() => true);
  const newIds = new Set(partial.cases.map((c) => c.id));
  const kept = (previous?.cases ?? []).filter((c) => !newIds.has(c.id) && !inScope(c, selection.args, dirs) && !(c.file && meta.changed.includes(c.file) && !exists(c.file)));
  const cases = [...kept, ...partial.cases];
  const count = (s: TestCase["status"]) => cases.filter((c) => c.status === s).length;
  const partialInfo: PartialRun = {
    at: partial.at,
    changed: meta.changed,
    ran: partial.total,
    passed: partial.passed,
    failed: partial.failed + partial.errors,
    skipped: partial.skipped,
    elapsedMs: meta.elapsedMs,
    granularity: selection.granularity,
    items: selection.items.map((i) => ({ path: i.path, how: i.how, ...(i.tier ? { tier: i.tier } : {}) })),
    skippedFiles: selection.skipped,
  };
  return {
    source: previous?.source ?? partial.source,
    at: partial.at,
    ...(previous ? { fullAt: previous.fullAt ?? previous.at } : {}),
    partial: partialInfo,
    total: cases.length,
    passed: count("passed"),
    failed: count("failed"),
    errors: count("error"),
    skipped: count("skipped"),
    cases,
  };
}

export interface AutoTestOptions {
  stateDir: string;
  /** 解释器；没有就不开。 */
  python?: string;
  enabled: boolean;
  /** 最后一次改动后等多久再跑（合并连续改动）。 */
  debounceMs?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
  /** 跑命令的函数；测试里换成假的。 */
  run?: typeof runCommand;
}

export interface AutoTestHooks {
  tests: () => TestSnapshot | undefined;
  known: () => Set<string>;
  onEvent: (ev: Omit<ActivityEvent, "id">) => void;
  onState: (state: AutoTestState) => void;
  /** 结果写好了，该重算快照。 */
  onResults: () => void;
}

export class AutoTester {
  readonly root: string;
  readonly options: AutoTestOptions;
  private readonly hooks: AutoTestHooks;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running: AutoTestState["running"] | undefined;
  private busy = false;
  private why: string | undefined;
  private enabled: boolean;
  private readonly log: (line: string) => void;
  /** 自己最近一次合并出的结果。快照要等重算才更新，两次自动跑挨得近时以它为准，免得第一次的结果被盖掉。 */
  private lastMerged: TestRun | undefined;

  constructor(root: string, options: AutoTestOptions, hooks: AutoTestHooks) {
    this.root = root;
    this.options = options;
    this.hooks = hooks;
    this.enabled = options.enabled && Boolean(options.python);
    if (!options.enabled) this.why = "关了（--no-auto-test 或 overlay 的 test_results.auto: false）";
    else if (!options.python) this.why = "没找到项目的 Python 解释器（.venv），或在 overlay 的 test_results.python 里指定";
    this.log = options.log ?? (() => undefined);
  }

  /** 启动时确认解释器里有 pytest；没有就关掉并说明。 */
  async probe(): Promise<AutoTestState> {
    if (this.enabled && this.options.python) {
      const r = await probeModule(this.options.python, "pytest", this.root);
      if (r !== "ok") {
        this.enabled = false;
        this.why = r === "no-interpreter" ? `找不到 Python 解释器 ${this.options.python}（overlay 的 test_results.python 写错了？）` : `${this.options.python} 里没有 pytest`;
      }
    }
    const s = this.state();
    this.hooks.onState(s);
    return s;
  }

  state(): AutoTestState {
    return {
      enabled: this.enabled,
      ...(this.options.python ? { python: this.options.python } : {}),
      ...(this.why ? { why: this.why } : {}),
      ...(this.running ? { running: this.running } : {}),
    };
  }

  /** 这些文件变了（相对仓库路径）。 */
  notice(changed: string[]): void {
    if (!this.enabled) return;
    for (const p of changed) {
      if (!p.endsWith(".py") || p.startsWith(".workbench/")) continue;
      this.pending.add(p);
    }
    if (this.pending.size) this.schedule(this.options.debounceMs ?? 1500);
  }

  /** 不等了，现在就跑（比如 Claude 本轮结束）。 */
  flushNow(): void {
    if (this.pending.size) this.schedule(0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  /** 合并的基础：自己上次合并的结果通常比快照新（快照要等重算）；全量跑过之后快照里的更新，以时间为准。 */
  previousRun(): TestRun | undefined {
    const snap = this.hooks.tests()?.run;
    const mine = this.lastMerged;
    if (!mine) return snap;
    if (!snap) return mine;
    return Date.parse(snap.at) > Date.parse(mine.at) ? snap : mine;
  }

  private async flush(): Promise<void> {
    if (this.busy) {
      this.schedule(500);
      return;
    }
    const changed = [...this.pending].sort();
    this.pending.clear();
    if (!changed.length) return;
    this.busy = true;
    try {
      await this.runFor(changed);
    } catch (error) {
      this.hooks.onEvent({ at: new Date().toISOString(), source: "system", kind: "autotest", text: `自动跑测试出错：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      this.busy = false;
      this.running = undefined;
      this.hooks.onState(this.state());
      if (this.pending.size) this.schedule(this.options.debounceMs ?? 1500);
    }
  }

  private async runFor(changed: string[]): Promise<void> {
    const exists = (p: string) => fs.existsSync(path.join(this.root, p));
    let selection = selectTests(changed, this.hooks.tests(), { exists });
    const describe = (s: Selection) => s.items.map((i) => `${i.path}：${i.how}`).join("；");
    if (!selection.args.length) {
      const why = selection.skipped.map((s) => `${s.path}（${s.why}）`).join("、");
      this.hooks.onEvent({ at: new Date().toISOString(), source: "system", kind: "autotest", text: `改了 ${changed.join("、")}，没跑测试：${why}` });
      return;
    }
    const python = this.options.python ?? "python";
    const dir = path.join(this.options.stateDir, "test-results", "partial");
    fs.mkdirSync(dir, { recursive: true });
    const junit = path.join(dir, "junit.xml");
    const started = Date.now();
    this.running = { since: new Date(started).toISOString(), changed, estimated: selection.estimated, args: selection.args.length };
    this.hooks.onState(this.state());
    this.hooks.onEvent({
      at: new Date().toISOString(),
      source: "system",
      kind: "autotest",
      text: `自动跑相关测试：${selection.estimated ? `约 ${selection.estimated} 个用例` : `${selection.args.length} 个目标`}（${describe(selection)}）…`,
    });
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
    const run = this.options.run ?? runCommand;
    const pytest = (args: string[]) => run(python, ["-m", "pytest", "-p", "no:cacheprovider", "-q", `--junitxml=${junit}`, ...args], this.root, env, (l) => this.log(l), this.options.timeoutMs ?? 600_000);
    fs.rmSync(junit, { force: true });
    let r = await pytest(selection.args);
    if (r.code === 4 && selection.granularity === "case") {
      // 用例 id 失效（测试改名或删了）：退到按文件跑一次。
      const files = [...new Set(selection.args.map(fileOfArg))].filter(exists);
      selection = { ...selection, args: files, granularity: "file" };
      fs.rmSync(junit, { force: true });
      r = await pytest(files);
    }
    const elapsedMs = Date.now() - started;
    if (!fs.existsSync(junit)) {
      this.hooks.onEvent({ at: new Date().toISOString(), source: "system", kind: "autotest", text: `自动跑测试没有产出结果（退出码 ${r.code}）：${r.tail.trim().split("\n").slice(-2).join(" ")}` });
      return;
    }
    const known = this.hooks.known();
    const partial = parseJunit(fs.readFileSync(junit, "utf8"), known, "partial/junit.xml", new Date().toISOString());
    const previous = this.previousRun();
    const merged = mergeRuns(previous, partial, selection, { changed, elapsedMs, exists });
    const out = path.join(this.options.stateDir, "test-results", "results.json");
    const tmp = out + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, run: merged }), "utf8");
    fs.renameSync(tmp, out);
    this.lastMerged = merged;
    this.log(`自动跑了 ${partial.total} 个用例：通过 ${partial.passed}、失败 ${partial.failed + partial.errors}、跳过 ${partial.skipped}，${(elapsedMs / 1000).toFixed(1)} 秒`);
    this.hooks.onResults();
  }
}
