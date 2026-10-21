import { git } from "./files.ts";
import type { CommitRecord } from "./types.ts";

export const DEFAULT_STAGE_TAG = String.raw`[vV]\d+(?:\.\d+)*\s+S\d+(?:\.\d+)?[a-z]?`;

export interface HistoryOptions {
  stageTag?: string;
  max?: number;
}

/** 读 git log，含每个提交改动的文件与增删行数；不读 diff 正文。 */
export async function readHistory(root: string, options: HistoryOptions = {}): Promise<CommitRecord[]> {
  const stageRx = new RegExp(options.stageTag ?? DEFAULT_STAGE_TAG);
  const args = ["log", "--numstat", "--format=%x1e%H%x1f%aI%x1f%an%x1f%s", "--no-color"];
  if (options.max) args.push(`-n`, String(options.max));
  let out: string;
  try {
    out = await git(root, args);
  } catch {
    return [];
  }
  const commits: CommitRecord[] = [];
  for (const chunk of out.split("\x1e")) {
    if (!chunk.trim()) continue;
    const [header = "", ...rest] = chunk.split("\n");
    const [sha = "", date = "", author = "", subject = ""] = header.split("\x1f");
    if (!sha) continue;
    const files: CommitRecord["files"] = [];
    for (const line of rest) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!m) continue;
      const rawPath = m[3] ?? "";
      const renamed = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(rawPath);
      const p = renamed ? `${renamed[1]}${renamed[3]}${renamed[4]}` : rawPath.includes(" => ") ? rawPath.split(" => ")[1] ?? rawPath : rawPath;
      files.push({ path: p, added: m[1] === "-" ? 0 : Number(m[1]), deleted: m[2] === "-" ? 0 : Number(m[2]) });
    }
    const stage = stageRx.exec(subject)?.[0];
    commits.push({ sha, date, author, subject, files, ...(stage ? { stage: normalizeStage(stage) } : {}) });
  }
  return commits;
}

/** 把「v0.4.26 S9.2b」这类标签压成统一写法：去多余空白。 */
export function normalizeStage(tag: string): string {
  return tag.replace(/\s+/g, " ").trim();
}

export interface StageEntry {
  stage: string;
  first: string;
  last: string;
  commits: number;
}

/** 阶段序列：按首次出现时间排序。 */
export function stageTimeline(commits: CommitRecord[]): StageEntry[] {
  const map = new Map<string, StageEntry>();
  for (const c of commits) {
    if (!c.stage) continue;
    const entry = map.get(c.stage);
    if (!entry) map.set(c.stage, { stage: c.stage, first: c.date, last: c.date, commits: 1 });
    else {
      entry.commits++;
      if (c.date < entry.first) entry.first = c.date;
      if (c.date > entry.last) entry.last = c.date;
    }
  }
  return [...map.values()].sort((a, b) => a.first.localeCompare(b.first));
}

export interface Hotspot {
  path: string;
  commits: number;
  churn: number;
  lastTouched: string;
}

/** 热点：按提交次数与增删行数。 */
export function hotspots(commits: CommitRecord[], limit = 20): Hotspot[] {
  const map = new Map<string, Hotspot>();
  for (const c of commits) {
    for (const f of c.files) {
      const h = map.get(f.path) ?? { path: f.path, commits: 0, churn: 0, lastTouched: c.date };
      h.commits++;
      h.churn += f.added + f.deleted;
      if (c.date > h.lastTouched) h.lastTouched = c.date;
      map.set(f.path, h);
    }
  }
  return [...map.values()].sort((a, b) => b.commits - a.commits || b.churn - a.churn).slice(0, limit);
}

/** 变更耦合：同一提交里一起改的文件对，返回共现次数最高的若干对。 */
export function changeCoupling(commits: CommitRecord[], limit = 20, maxFilesPerCommit = 30): { a: string; b: string; together: number }[] {
  const pairs = new Map<string, number>();
  for (const c of commits) {
    const paths = c.files.map((f) => f.path).sort();
    if (paths.length < 2 || paths.length > maxFilesPerCommit) continue;
    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        const key = `${paths[i]}\u0000${paths[j]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }
  return [...pairs]
    .map(([key, together]) => {
      const [a = "", b = ""] = key.split("\u0000");
      return { a, b, together };
    })
    .sort((x, y) => y.together - x.together)
    .slice(0, limit);
}
