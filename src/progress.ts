/** 证据层：任务进度由机器可见的信号算出来，每个数字标来源与等级（设计稿 v1.2 第 3、4、5 节）。 */
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

export interface TaskProgress {
  taskId: string;
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
  code: { current?: string; at?: string; tier: Tier };
  relation: "一致" | "文档落后于代码" | "代码落后于文档" | "无法比较";
  text: string;
}

export interface Inconsistency {
  taskId?: string;
  kind: string;
  text: string;
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

export function computeProgress(task: TaskRecord, commits: CommitRecord[], changes: ChangeRecord[], touched: Record<string, Touch>, now = Date.now(), children: TaskRecord[] = []): TaskProgress {
  const range = RANGE[task.status];
  const signals: Signal[] = [];
  const weights: { w: number; v: number }[] = [];
  if (task.criteria.length) {
    const done = task.criteria.filter((c) => c.done).length;
    const v = done / task.criteria.length;
    signals.push({ name: "验收项", value: v, text: `验收项打勾 ${done} / ${task.criteria.length}`, tier: "T2", source: "任务文件里的复选框" });
    weights.push({ w: 0.5, v });
  } else if (children.length) {
    const done = children.filter((c) => c.status === "done").length;
    const v = done / children.length;
    signals.push({ name: "子任务", value: v, text: `子任务完成 ${done} / ${children.length}`, tier: "T2", source: "任务列表里缩进在它下面的条目" });
    weights.push({ w: 0.5, v });
  }
  signals.push({ name: "测试", text: "还没接测试结果（无数据）", tier: "T0", source: "pytest / junit，尚未接入" });
  const changedSet = new Set(changes.map((c) => c.path));
  if (task.files.length) {
    const hit = task.files.filter((f) => changedSet.has(f) || touched[f]);
    const v = hit.length / task.files.length;
    signals.push({ name: "文件改动", value: v, text: `提到的 ${task.files.length} 个文件里，这次会话改了 ${hit.length} 个`, tier: task.filesTier === "T2" ? "T0" : "T1", source: task.filesTier === "T2" ? "任务声明的文件 × git 差异" : "任务行里反引号提到的文件（猜的）× git 差异" });
    weights.push({ w: 0.2, v });
  }
  const referencing = looksLikeId(task.id) ? commits.filter((c) => idPattern(task.id).test(c.subject)).map((c) => ({ sha: c.sha, date: c.date, subject: c.subject })) : [];
  if (looksLikeId(task.id)) {
    signals.push({ name: "提交引用", ...(referencing.length ? { value: 1 } : {}), text: referencing.length ? `${referencing.length} 个提交的信息里提到了 ${task.id}，最近 ${referencing[0]?.date.slice(0, 16).replace("T", " ")}` : `没有提交信息提到 ${task.id}`, tier: "T0", source: "git log" });
  } else {
    signals.push({ name: "提交引用", text: `「${task.id}」不像编号，不去提交信息里找（避免假阳性）`, tier: "T0", source: "git log" });
  }
  const active = task.files.some((f) => {
    const t = touched[f];
    return t && now - Date.parse(t.at) < 30 * 60 * 1000;
  });
  if (active) signals.push({ name: "正在动", value: 1, text: "最近 30 分钟内 Claude 改过它提到的文件", tier: "T0", source: "hook 事件" });
  let percent: number | undefined;
  let formula = "没有任何机器可见的信号，只有流程状态";
  if (weights.length) {
    const total = weights.reduce((s, x) => s + x.w, 0);
    const position = weights.reduce((s, x) => s + x.w * x.v, 0) / total;
    percent = Math.round(range[0] + position * (range[1] - range[0]));
    formula = `状态「${task.status}」对应区间 ${range[0]}–${range[1]}；区间内位置 = ${weights.map((x) => `${x.w}×${x.v.toFixed(2)}`).join(" + ")} ÷ ${total.toFixed(1)} = ${position.toFixed(2)}`;
  } else if (task.status === "done") {
    percent = 100;
    formula = "状态为完成，但没有机器可见的信号佐证";
  }
  return { taskId: task.id, ...(percent !== undefined ? { percent } : {}), range, signals, formula, commits: referencing.slice(0, 10), active };
}

export function computeGauge(tasks: TaskRecord[], commits: CommitRecord[]): StageGauge {
  const staged = tasks.filter((t) => t.stage);
  const total = staged.length;
  const done = staged.filter((t) => t.status === "done").length;
  const developing = staged.filter((t) => t.status === "developing").sort((a, b) => compareStage(b.stage!, a.stage!));
  const highestDone = staged.filter((t) => t.status === "done").sort((a, b) => compareStage(b.stage!, a.stage!))[0];
  const docCurrent = developing[0]?.stage ?? highestDone?.stage;
  const tagged = commits.filter((c) => c.stage);
  const codeStages = tagged.map((c) => ({ key: parseStage(c.stage ?? ""), at: c.date })).filter((x): x is { key: StageKey; at: string } => !!x.key);
  codeStages.sort((a, b) => compareStage(b.key, a.key));
  const codeCurrent = codeStages[0];
  let relation: StageGauge["relation"] = "无法比较";
  let text = "任务列表或提交标签缺一样，比不了";
  if (docCurrent && codeCurrent) {
    const docDoneBeyondCode = highestDone && highestDone.stage!.major > codeCurrent.key.major;
    if (codeCurrent.key.major > docCurrent.major) {
      relation = "文档落后于代码";
      text = developing[0]
        ? `任务列表还把 ${docCurrent.text} 标为正在做，提交信息已经到了 ${codeCurrent.key.text}`
        : `任务列表最高完成到 ${docCurrent.text}，提交信息已经到了 ${codeCurrent.key.text}`;
    } else if (docDoneBeyondCode) {
      relation = "代码落后于文档";
      text = `任务列表说 ${highestDone?.stage?.text} 已完成，但提交信息最高只标到 ${codeCurrent.key.text}`;
    } else {
      relation = "一致";
      text = `任务列表${developing[0] ? "正在做" : "完成到"} ${docCurrent.text}，提交信息最近标到 ${codeCurrent.key.text}`;
    }
  }
  return {
    doc: { ...(docCurrent ? { current: docCurrent.text } : {}), done, total, tier: "T2" },
    code: { ...(codeCurrent ? { current: codeCurrent.key.text, at: codeCurrent.at } : {}), tier: "T0" },
    relation,
    text,
  };
}

export function childrenOf(tasks: TaskRecord[], id: string): TaskRecord[] {
  return tasks.filter((t) => t.parent === id);
}

export function findInconsistencies(tasks: TaskRecord[], progress: Map<string, TaskProgress>, gauge: StageGauge, now = Date.now()): Inconsistency[] {
  const out: Inconsistency[] = [];
  if (gauge.relation === "文档落后于代码" || gauge.relation === "代码落后于文档") out.push({ kind: gauge.relation, text: gauge.text });
  const seen = new Map<string, number>();
  for (const t of tasks) seen.set(t.id, (seen.get(t.id) ?? 0) + 1);
  for (const [id, n] of seen) if (n > 1 && looksLikeId(id)) out.push({ taskId: id, kind: "编号重复", text: `${id} 在任务列表里出现了 ${n} 次` });
  for (const t of tasks) {
    const kids = childrenOf(tasks, t.id);
    if (kids.length && kids.every((k) => k.status === "done") && t.status !== "done") {
      out.push({ taskId: t.id, kind: "子任务都完成了", text: `${t.id} 下面 ${kids.length} 个子任务全部标完成，它自己还标「${t.status === "developing" ? "正在做" : "待做"}」` });
    }
    const p = progress.get(t.id);
    if (!p) continue;
    if (t.status === "done" && t.dates.last) {
      const after = p.commits.filter((c) => c.date.slice(0, 10) > (t.dates.last ?? ""));
      if (after.length) out.push({ taskId: t.id, kind: "完成后仍在改", text: `${t.id} 在 ${t.dates.last} 标为完成，之后还有 ${after.length} 个提交提到它（最近 ${after[0]?.date.slice(0, 10)}）` });
    }
    if (t.status === "developing" && !p.active) {
      const latest = p.commits[0]?.date;
      const stale = !latest || now - Date.parse(latest) > 48 * 3600 * 1000;
      if (stale && (latest || t.dates.last)) out.push({ taskId: t.id, kind: "停滞", text: `${t.id} 标为正在做，但 48 小时内没有提到它的提交，也没有 Claude 触碰它提到的文件` });
    }
  }
  // 同一个编号出现两次时，子任务检查会重复两遍；按文字去重。
  const seenText = new Set<string>();
  return out.filter((i) => {
    const key = `${i.kind}|${i.text}`;
    if (seenText.has(key)) return false;
    seenText.add(key);
    return true;
  });
}
