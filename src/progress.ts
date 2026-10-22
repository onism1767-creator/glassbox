/**
 * 证据层：任务状态与进度由机器可见的信号算出来（设计稿 v1.2 第 3、4、5 节）。
 * 原则（用户 2026-10-22 定）：任务文档读一次当「计划清单」，做没做完以代码为准；文档没更新不算错。
 */
import { compareStage, parseStage, type TaskRecord, type StageKey, type TaskStatus } from "./tasks.ts";
import type { CommitRecord, ChangeRecord, Tier, Touch } from "./types.ts";

export interface Signal {
  name: string;
  /** 0–1；没有数据时 undefined。 */
  value?: number;
  text: string;
  tier: Tier;
  source: string;
}

export interface DerivedStatus {
  status: TaskStatus;
  /** 为什么这么判。 */
  basis: string;
  tier: Tier;
  certainty: "确定" | "推测" | "只有文档说法";
}

export interface TaskProgress {
  taskId: string;
  /** 代码说的状态。 */
  derived: DerivedStatus;
  /** 文档里写的状态。 */
  docStatus: TaskStatus;
  /** 0–100；没有任何信号时 undefined。 */
  percent?: number;
  range: [number, number];
  signals: Signal[];
  formula: string;
  commits: { sha: string; date: string; subject: string }[];
  active: boolean;
}

export interface StageGauge {
  doc: { current?: string; done: number; total: number; tier: Tier };
  code: { current?: string; at?: string; derivedDone: number; derivedDeveloping: number; tier: Tier };
  /** 文档没更新的任务数。 */
  stale: number;
  text: string;
}

export interface Inconsistency {
  taskId?: string;
  kind: string;
  text: string;
  /** info：文档没更新这类不算错的；warn：值得看一眼的。 */
  severity: "info" | "warn";
}

const RANGE: Record<TaskStatus, [number, number]> = {
  todo: [0, 0],
  developing: [10, 70],
  rework: [60, 70],
  review: [70, 85],
  passed: [85, 85],
  integrated: [95, 95],
  "integration-review": [95, 97],
  "integration-passed": [97, 97],
  handtest: [97, 99],
  done: [100, 100],
};

function idPattern(id: string): RegExp {
  return new RegExp(`(^|[^\\w.])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.])`);
}

/** 像编号的 id 才去提交信息里找（S6、T-12）；「拍板」这种普通词会满屏假阳性。 */
export function looksLikeId(id: string): boolean {
  return /[A-Za-z0-9]/.test(id) && id.length <= 24;
}

export function latestCodeStage(commits: CommitRecord[]): { key: StageKey; at: string } | undefined {
  const stages = commits.map((c) => ({ key: parseStage(c.stage ?? ""), at: c.date })).filter((x): x is { key: StageKey; at: string } => !!x.key);
  stages.sort((a, b) => compareStage(b.key, a.key));
  return stages[0];
}

function daysAgo(iso: string, now: number): number {
  return Math.round((now - Date.parse(iso)) / 86400000);
}

export interface DeriveInput {
  task: TaskRecord;
  referencing: { sha: string; date: string; subject: string }[];
  latestCode?: { key: StageKey; at: string };
  children: DerivedStatus[];
  filesChanged: number;
  active: boolean;
  now: number;
}

/** 代码说这个任务做到哪了。 */
export function deriveStatus({ task, referencing, latestCode, children, filesChanged, active, now }: DeriveInput): DerivedStatus {
  if (children.length) {
    const done = children.filter((c) => c.status === "done").length;
    if (done === children.length) return { status: "done", basis: `${children.length} 个子任务按代码判断都完成了`, tier: "T1", certainty: "确定" };
    if (done > 0 || children.some((c) => c.status === "developing")) return { status: "developing", basis: `子任务按代码判断完成 ${done} / ${children.length}`, tier: "T1", certainty: "确定" };
  }
  const latest = referencing[0];
  if (latest) {
    if (task.stage && latestCode) {
      const cmp = compareStage(latestCode.key, task.stage);
      const sameMajorParent = task.stage.minor === 0 && task.stage.suffix === "" && latestCode.key.major === task.stage.major;
      if (cmp > 0 && !sameMajorParent) {
        return { status: "done", basis: `提交信息已经标到后面的 ${latestCode.key.text}；${task.id} 自己有 ${referencing.length} 个提交，最后一个在 ${latest.date.slice(0, 10)}`, tier: "T1", certainty: "确定" };
      }
      if (cmp === 0 || sameMajorParent) {
        return { status: "developing", basis: `提交信息最近就标在 ${latestCode.key.text}，正在这一步上（最后一个提交 ${latest.date.slice(0, 10)}）`, tier: "T1", certainty: "确定" };
      }
    }
    const days = daysAgo(latest.date, now);
    if (active || days <= 2) return { status: "developing", basis: `${referencing.length} 个提交提到它，最近 ${days === 0 ? "今天" : days + " 天前"}${active ? "，Claude 刚改过它的文件" : ""}`, tier: "T1", certainty: "确定" };
    if (task.status === "done") return { status: "done", basis: `有 ${referencing.length} 个提交提到它，最后一个 ${days} 天前，文档也说完成`, tier: "T1", certainty: "确定" };
    return { status: "developing", basis: `有 ${referencing.length} 个提交提到它，但 ${days} 天没动，文档也没说完成`, tier: "T1", certainty: "推测" };
  }
  if (filesChanged > 0 || active) return { status: "developing", basis: active ? "Claude 刚改过它提到的文件" : `它提到的文件里这次会话改了 ${filesChanged} 个`, tier: "T1", certainty: "推测" };
  if (!task.stage && !looksLikeId(task.id)) return { status: task.status, basis: "没有编号，代码里找不到它的痕迹，只能照文档", tier: "T2", certainty: "只有文档说法" };
  return { status: task.status, basis: "代码里没有它的痕迹（没有提交提到它、没有文件改动），只能照文档", tier: "T2", certainty: "只有文档说法" };
}

export interface ProgressContext {
  commits: CommitRecord[];
  changes: ChangeRecord[];
  touched: Record<string, Touch>;
  now?: number;
}

/** 给一批任务算进度：先算叶子，再算父任务（父任务看子任务）。 */
export function computeAllProgress(tasks: TaskRecord[], ctx: ProgressContext): Map<string, TaskProgress> {
  const now = ctx.now ?? Date.now();
  const latestCode = latestCodeStage(ctx.commits);
  const changedSet = new Set(ctx.changes.map((c) => c.path));
  const byParent = new Map<string, TaskRecord[]>();
  for (const t of tasks) if (t.parent) byParent.set(t.parent, [...(byParent.get(t.parent) ?? []), t]);
  const memo = new Map<TaskRecord, TaskProgress>();
  const compute = (task: TaskRecord, depth = 0): TaskProgress => {
    const cached = memo.get(task);
    if (cached) return cached;
    const children = depth < 8 ? (byParent.get(task.id) ?? []).filter((k) => k !== task).map((k) => compute(k, depth + 1)) : [];
    const referencing = looksLikeId(task.id) ? ctx.commits.filter((c) => idPattern(task.id).test(c.subject)).map((c) => ({ sha: c.sha, date: c.date, subject: c.subject })) : [];
    const hit = task.files.filter((f) => changedSet.has(f) || ctx.touched[f]);
    const active = task.files.some((f) => {
      const t = ctx.touched[f];
      return !!t && now - Date.parse(t.at) < 30 * 60 * 1000;
    });
    const derived = deriveStatus({ task, referencing, ...(latestCode ? { latestCode } : {}), children: children.map((c) => c.derived), filesChanged: hit.length, active, now });
    const range = RANGE[derived.status];
    const signals: Signal[] = [];
    const weights: { w: number; v: number }[] = [];
    if (task.criteria.length) {
      const done = task.criteria.filter((c) => c.done).length;
      const v = done / task.criteria.length;
      signals.push({ name: "验收项", value: v, text: `验收项打勾 ${done} / ${task.criteria.length}`, tier: "T2", source: "任务文件里的复选框" });
      weights.push({ w: 0.5, v });
    } else if (children.length) {
      const done = children.filter((c) => c.derived.status === "done").length;
      const v = done / children.length;
      signals.push({ name: "子任务", value: v, text: `子任务按代码判断完成 ${done} / ${children.length}`, tier: "T1", source: "缩进在它下面的条目，各自按代码判断" });
      weights.push({ w: 0.5, v });
    }
    signals.push({ name: "测试", text: "还没接测试结果（无数据）", tier: "T0", source: "pytest / junit，尚未接入" });
    if (task.files.length) {
      const v = hit.length / task.files.length;
      signals.push({ name: "文件改动", value: v, text: `提到的 ${task.files.length} 个文件里，这次会话改了 ${hit.length} 个`, tier: task.filesTier === "T2" ? "T0" : "T1", source: task.filesTier === "T2" ? "任务声明的文件 × git 差异" : "任务行里反引号提到的文件（猜的）× git 差异" });
      weights.push({ w: 0.2, v });
    }
    if (looksLikeId(task.id)) {
      signals.push({ name: "提交引用", ...(referencing.length ? { value: 1 } : {}), text: referencing.length ? `${referencing.length} 个提交的信息里提到了 ${task.id}，最近 ${referencing[0]?.date.slice(0, 16).replace("T", " ")}` : `没有提交信息提到 ${task.id}`, tier: "T0", source: "git log" });
    } else {
      signals.push({ name: "提交引用", text: `「${task.id}」不像编号，不去提交信息里找（避免假阳性）`, tier: "T0", source: "git log" });
    }
    if (active) signals.push({ name: "正在动", value: 1, text: "最近 30 分钟内 Claude 改过它提到的文件", tier: "T0", source: "hook 事件" });
    let percent: number | undefined;
    let formula = `代码说的状态「${derived.status}」对应区间 ${range[0]}–${range[1]}；没有别的信号`;
    if (derived.status === "done") {
      percent = 100;
      formula = `代码说完成：${derived.basis}`;
    } else if (weights.length) {
      const total = weights.reduce((s, x) => s + x.w, 0);
      const position = weights.reduce((s, x) => s + x.w * x.v, 0) / total;
      percent = Math.round(range[0] + position * (range[1] - range[0]));
      formula = `代码说的状态「${derived.status}」对应区间 ${range[0]}–${range[1]}；区间内位置 = ${weights.map((x) => `${x.w}×${x.v.toFixed(2)}`).join(" + ")} ÷ ${total.toFixed(1)} = ${position.toFixed(2)}`;
    } else if (derived.status === "developing") {
      percent = range[0];
      formula = `代码说正在做（${derived.basis}），没有更细的信号，画在区间起点`;
    }
    const p: TaskProgress = { taskId: task.id, derived, docStatus: task.status, ...(percent !== undefined ? { percent } : {}), range, signals, formula, commits: referencing.slice(0, 10), active };
    memo.set(task, p);
    return p;
  };
  const out = new Map<string, TaskProgress>();
  for (const t of tasks) {
    const p = compute(t);
    if (!out.has(t.id)) out.set(t.id, p);
  }
  return out;
}

/** 兼容旧调用：单个任务。 */
export function computeProgress(task: TaskRecord, commits: CommitRecord[], changes: ChangeRecord[], touched: Record<string, Touch>, now = Date.now(), children: TaskRecord[] = []): TaskProgress {
  const all = computeAllProgress([task, ...children.filter((c) => c !== task)], { commits, changes, touched, now });
  return all.get(task.id)!;
}

export function computeGauge(tasks: TaskRecord[], commits: CommitRecord[], progress?: Map<string, TaskProgress>): StageGauge {
  const staged = tasks.filter((t) => t.stage);
  const total = staged.length;
  const done = staged.filter((t) => t.status === "done").length;
  const developing = staged.filter((t) => t.status === "developing").sort((a, b) => compareStage(b.stage!, a.stage!));
  const highestDone = staged.filter((t) => t.status === "done").sort((a, b) => compareStage(b.stage!, a.stage!))[0];
  const docCurrent = developing[0]?.stage ?? highestDone?.stage;
  const codeCurrent = latestCodeStage(commits);
  let derivedDone = 0;
  let derivedDeveloping = 0;
  let stale = 0;
  if (progress) {
    for (const t of staged) {
      const p = progress.get(t.id);
      if (!p) continue;
      if (p.derived.status === "done") derivedDone++;
      if (p.derived.status === "developing") derivedDeveloping++;
      if (p.derived.certainty !== "只有文档说法" && p.derived.status !== t.status) stale++;
    }
  }
  const text = codeCurrent
    ? `以代码为准：提交信息最近标到 ${codeCurrent.key.text}，${total} 个带编号的任务里按代码判断完成 ${derivedDone} 个、正在做 ${derivedDeveloping} 个${docCurrent ? `；任务列表自己写的是${developing[0] ? "正在" : "完成到"} ${docCurrent.text}${stale ? `，有 ${stale} 项没跟着更新` : ""}` : ""}`
    : "提交信息里没有阶段标签，只能照任务列表";
  return {
    doc: { ...(docCurrent ? { current: docCurrent.text } : {}), done, total, tier: "T2" },
    code: { ...(codeCurrent ? { current: codeCurrent.key.text, at: codeCurrent.at } : {}), derivedDone, derivedDeveloping, tier: "T0" },
    stale,
    text,
  };
}

export function childrenOf(tasks: TaskRecord[], id: string): TaskRecord[] {
  return tasks.filter((t) => t.parent === id);
}

export function findInconsistencies(tasks: TaskRecord[], progress: Map<string, TaskProgress>, _gauge: StageGauge, now = Date.now()): Inconsistency[] {
  const out: Inconsistency[] = [];
  const seen = new Map<string, number>();
  for (const t of tasks) seen.set(t.id, (seen.get(t.id) ?? 0) + 1);
  for (const [id, n] of seen) if (n > 1 && looksLikeId(id)) out.push({ taskId: id, kind: "编号重复", text: `${id} 在任务列表里出现了 ${n} 次`, severity: "warn" });
  for (const t of tasks) {
    const p = progress.get(t.id);
    if (!p) continue;
    if (p.derived.certainty !== "只有文档说法" && p.derived.status !== t.status) {
      out.push({ taskId: t.id, kind: "文档没更新", text: `${t.id} 文档写「${t.status}」，代码说「${p.derived.status}」：${p.derived.basis}`, severity: "info" });
    }
    if (p.derived.status === "developing" && p.derived.certainty === "推测") {
      const latest = p.commits[0]?.date;
      if (latest && now - Date.parse(latest) > 48 * 3600 * 1000) out.push({ taskId: t.id, kind: "可能停了", text: `${t.id} 有提交提到它，但最近一次是 ${daysAgo(latest, now)} 天前，之后没动静也没标完成`, severity: "warn" });
    }
    if (t.status === "done" && t.dates.last) {
      const after = p.commits.filter((c) => c.date.slice(0, 10) > (t.dates.last ?? ""));
      if (after.length) out.push({ taskId: t.id, kind: "标完成后还有提交", text: `${t.id} 在 ${t.dates.last} 标为完成，之后还有 ${after.length} 个提交提到它（最近 ${after[0]?.date.slice(0, 10)}）`, severity: "info" });
    }
  }
  const seenText = new Set<string>();
  return out.filter((i) => {
    const key = `${i.kind}|${i.text}`;
    if (seenText.has(key)) return false;
    seenText.add(key);
    return true;
  });
}
