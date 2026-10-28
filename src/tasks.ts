/**
 * 任务来源（声明层，T2）：
 * - emoji-list：项目已有的任务列表，如 GEO 的 docs/任务列表.md，每行 `- ✅ **S8.1** 标题(2026-10-14；…)`
 * - standard：.workbench/tasks/*.md，front-matter + 正文复选框
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Evidence } from "./types.ts";

export type TaskStatus = "todo" | "developing" | "review" | "rework" | "passed" | "integrated" | "integration-review" | "integration-passed" | "handtest" | "done";

export interface StageKey {
  major: number;
  minor: number;
  suffix: string;
  text: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  status: TaskStatus;
  source: Evidence;
  format: "emoji-list" | "standard";
  parent?: string;
  stage?: StageKey;
  /** 行里出现的日期：最早、最晚。 */
  dates: { first?: string; last?: string };
  decided?: "user" | "claude";
  /** 行里声称的「N 测试全绿」。 */
  testsClaimed?: number;
  /** 认领或提到的文件；emoji-list 里是从反引号猜的（T1），standard 里是声明的（T2）。 */
  files: string[];
  filesTier: "T1" | "T2";
  criteria: { text: string; done: boolean }[];
  priority?: string;
  dependsOn: string[];
  estimate?: string;
}

export interface TaskSource {
  file: string;
  format: "emoji-list" | "standard";
}

const STATUS_EMOJI: Record<string, TaskStatus> = { "✅": "done", "🔨": "developing", "⏳": "todo", "❌": "rework", "🧪": "review" };

export function parseStage(id: string): StageKey | undefined {
  const m = /\bS(\d+)(?:\.(\d+))?([a-z])?\b/.exec(id);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: m[2] ? Number(m[2]) : 0, suffix: m[3] ?? "", text: m[0] };
}

export function compareStage(a: StageKey, b: StageKey): number {
  return a.major - b.major || a.minor - b.minor || a.suffix.localeCompare(b.suffix);
}

const DATE_RX = /\d{4}-\d{2}-\d{2}/g;
const FILE_RX = /`([\w./-]+\.(?:py|yaml|yml|md|html|json|txt|toml|ts|tsx|js|css|sql))`/g;

/** 解析 emoji 列表格式的任务文件。 */
export function parseEmojiList(file: string, text: string): TaskRecord[] {
  const tasks: TaskRecord[] = [];
  const stack: { indent: number; id: string }[] = [];
  // Windows 上改过的文件常是 CRLF；正则里的 . 不匹配 \r，不去掉的话整个清单一条都读不出。
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = /^(\s*)-\s*(✅|🔨|⏳|❌|🧪)\s*(.*)$/u.exec(line);
    if (!m) continue;
    const indent = (m[1] ?? "").length;
    const status = STATUS_EMOJI[m[2] ?? ""] ?? "todo";
    let rest = m[3] ?? "";
    let id = "";
    const bold = /^\*\*([^*]+)\*\*\s*/.exec(rest);
    if (bold) {
      id = (bold[1] ?? "").trim();
      rest = rest.slice(bold[0].length);
    } else {
      const head = /^(S\d+(?:\.\d+)?[a-z]?)\b\s*/.exec(rest);
      if (head) {
        id = head[1] ?? "";
        rest = rest.slice(head[0].length);
      }
    }
    if (!id) id = `行 ${i + 1}`;
    const cut = rest.search(/[（(:：;；]/);
    let title = (cut >= 0 ? rest.slice(0, cut) : rest).replace(/\*\*/g, "").trim().slice(0, 80);
    if (!title) {
      // 像「**S8.1**(2026-10-14;329 测试全绿)文案与数字:…」：编号后面紧跟括号里的验收说明，标题在括号后面
      const after = /^[（(][^）)]*[）)]\s*([^（(:：;；。]+)/.exec(rest);
      title = (after?.[1] ?? "").replace(/\*\*/g, "").trim().slice(0, 80);
    }
    if (!title) title = id;
    const dates = [...line.matchAll(DATE_RX)].map((x) => x[0]).sort();
    const files = [...new Set([...line.matchAll(FILE_RX)].map((x) => x[1] ?? "").filter(Boolean))];
    const tests = /(\d+)\s*测试全绿/.exec(line);
    while (stack.length && (stack[stack.length - 1]?.indent ?? 0) >= indent) stack.pop();
    const parent = stack[stack.length - 1]?.id;
    const stage = parseStage(id);
    tasks.push({
      id,
      title,
      status,
      source: { path: file, line: i + 1 },
      format: "emoji-list",
      ...(parent ? { parent } : {}),
      ...(stage ? { stage } : {}),
      dates: { ...(dates[0] ? { first: dates[0] } : {}), ...(dates.length ? { last: dates[dates.length - 1] } : {}) },
      ...(/用户定|用户\s*\S*\s*拍板/.test(line) ? { decided: "user" as const } : /Claude\s*提议/.test(line) ? { decided: "claude" as const } : {}),
      ...(tests ? { testsClaimed: Number(tests[1]) } : {}),
      files,
      filesTier: "T1",
      criteria: [],
      dependsOn: parent ? [parent] : [],
    });
    stack.push({ indent, id });
  }
  return tasks;
}

/** 解析 standard 格式：front-matter + 正文复选框。 */
export function parseStandardTask(file: string, text: string): TaskRecord | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  let meta: Record<string, unknown>;
  try {
    meta = (parseYaml(m[1] ?? "") as Record<string, unknown>) ?? {};
  } catch {
    return null;
  }
  const body = m[2] ?? "";
  const id = String(meta["id"] ?? path.basename(file, ".md"));
  const statusRaw = String(meta["status"] ?? "todo");
  const status = (["todo", "developing", "review", "rework", "passed", "integrated", "integration-review", "integration-passed", "handtest", "done"] as TaskStatus[]).includes(statusRaw as TaskStatus) ? (statusRaw as TaskStatus) : "todo";
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);
  const criteria: TaskRecord["criteria"] = [];
  for (const line of body.split(/\r?\n/)) {
    const c = /^\s*-\s*\[([ xX])\]\s*(.+)$/.exec(line);
    if (c) criteria.push({ text: (c[2] ?? "").trim(), done: (c[1] ?? " ") !== " " });
  }
  const stage = parseStage(id);
  return {
    id,
    title: String(meta["title"] ?? id),
    status,
    source: { path: file, line: 1 },
    format: "standard",
    ...(stage ? { stage } : {}),
    dates: {},
    files: list(meta["files"]),
    filesTier: "T2",
    criteria,
    ...(meta["priority"] ? { priority: String(meta["priority"]) } : {}),
    dependsOn: list(meta["depends_on"] ?? meta["dependsOn"]),
    ...(meta["estimate"] ? { estimate: String(meta["estimate"]) } : {}),
  };
}

/** 读 standard 任务目录。 */
export function readStandardTasks(dir: string): TaskRecord[] {
  if (!fs.existsSync(dir)) return [];
  const out: TaskRecord[] = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const full = path.join(dir, name);
    const rel = path.relative(path.dirname(path.dirname(dir)), full).split(path.sep).join("/");
    const t = parseStandardTask(rel, fs.readFileSync(full, "utf8"));
    if (t) out.push(t);
  }
  return out;
}

export function statusWord(s: TaskStatus): string {
  switch (s) {
    case "todo":
      return "待做";
    case "developing":
      return "正在做";
    case "review":
      return "等验收";
    case "rework":
      return "要返工";
    case "passed":
      return "验收通过";
    case "integrated":
      return "已合并";
    case "integration-review":
      return "合并后待验收";
    case "integration-passed":
      return "合并验收通过";
    case "handtest":
      return "等用户手测";
    case "done":
      return "完成";
  }
}
