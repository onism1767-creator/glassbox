import fs from "node:fs";
import path from "node:path";
import { git } from "./files.ts";
import type { Baseline, ChangeRecord } from "./types.ts";

export function baselineFile(stateDir: string): string {
  return path.join(stateDir, "baseline.json");
}

export async function currentHead(root: string): Promise<{ commit: string; branch: string | null }> {
  const commit = (await git(root, ["rev-parse", "HEAD"])).trim();
  let branch: string | null = null;
  try {
    branch = (await git(root, ["branch", "--show-current"])).trim() || null;
  } catch {
    branch = null;
  }
  return { commit, branch };
}

/** 记录基线：默认是「此刻的 HEAD」，由 SessionStart hook 或人手动调用。 */
export async function setBaseline(root: string, stateDir: string, reason: string, commit?: string): Promise<Baseline> {
  const head = await currentHead(root);
  const resolved = commit ? (await git(root, ["rev-parse", "--verify", `${commit}^{commit}`])).trim() : head.commit;
  const baseline: Baseline = { commit: resolved, branch: head.branch, setAt: new Date().toISOString(), reason };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(baselineFile(stateDir), JSON.stringify(baseline, null, 2) + "\n", "utf8");
  return baseline;
}

export function readBaseline(stateDir: string): Baseline | null {
  const file = baselineFile(stateDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Baseline;
  } catch {
    return null;
  }
}

export interface DiffResult {
  baseline: Baseline;
  head: { commit: string; branch: string | null };
  commitsSince: number;
  changes: ChangeRecord[];
}

/** 基线到工作区的差异：已提交的 + 未提交的 + 未跟踪的，都算。 */
export async function diffSinceBaseline(root: string, baseline: Baseline): Promise<DiffResult> {
  const head = await currentHead(root);
  const changes = new Map<string, ChangeRecord>();
  const nameStatus = await git(root, ["diff", "--name-status", "-M", "-z", baseline.commit]);
  const parts = nameStatus.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (!status) continue;
    const code = status[0] as ChangeRecord["status"];
    if (code === "R") {
      const to = parts[i + 2] ?? "";
      i += 2;
      if (to) changes.set(to, { path: to, status: "R", committed: true });
    } else {
      const p = parts[i + 1] ?? "";
      i += 1;
      if (p && (code === "A" || code === "M" || code === "D")) changes.set(p, { path: p, status: code, committed: true });
    }
  }
  const porcelain = await git(root, ["status", "--porcelain", "--untracked-files=all", "-z"]);
  for (const entry of porcelain.split("\0")) {
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const p = entry.slice(3);
    if (xy === "??") changes.set(p, { path: p, status: "?", committed: false });
    else {
      const existing = changes.get(p);
      const code: ChangeRecord["status"] = xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M";
      changes.set(p, { path: p, status: existing?.status ?? code, committed: false });
    }
  }
  let commitsSince = 0;
  try {
    commitsSince = Number((await git(root, ["rev-list", "--count", `${baseline.commit}..HEAD`])).trim()) || 0;
  } catch {
    commitsSince = 0;
  }
  return { baseline, head, commitsSince, changes: [...changes.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

/** 把变更投影到顶层目录。 */
export function changesByDir(changes: ChangeRecord[]): { dir: string; files: number; uncommitted: number }[] {
  const map = new Map<string, { dir: string; files: number; uncommitted: number }>();
  for (const c of changes) {
    const i = c.path.indexOf("/");
    const dir = i < 0 ? "." : c.path.slice(0, i);
    const entry = map.get(dir) ?? { dir, files: 0, uncommitted: 0 };
    entry.files++;
    if (!c.committed) entry.uncommitted++;
    map.set(dir, entry);
  }
  return [...map.values()].sort((a, b) => b.files - a.files);
}
