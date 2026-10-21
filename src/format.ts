import type { CommitRecord } from "./types.ts";
import { stageTimeline, hotspots, changeCoupling } from "./history.ts";
import { changesByDir, type DiffResult } from "./baseline.ts";

export function formatHistory(commits: CommitRecord[]): string {
  const lines: string[] = [];
  const tagged = commits.filter((c) => c.stage).length;
  lines.push(`提交 ${commits.length} 个，带阶段标签 ${tagged} 个`);
  const timeline = stageTimeline(commits);
  if (timeline.length) {
    lines.push("阶段序列（按首次出现）：");
    for (const s of timeline) lines.push(`  ${s.stage}  ${s.first.slice(0, 10)} → ${s.last.slice(0, 10)}  ${s.commits} 个提交`);
    const latest = timeline[timeline.length - 1];
    if (latest) lines.push(`代码实际到达的阶段：${latest.stage}（${latest.last.slice(0, 16)}）`);
  }
  lines.push("热点（提交次数 / 增删行）：");
  for (const h of hotspots(commits, 12)) lines.push(`  ${h.path}  ${h.commits} 次 / ${h.churn} 行  最近 ${h.lastTouched.slice(0, 10)}`);
  const coupling = changeCoupling(commits, 8);
  if (coupling.length) {
    lines.push("变更耦合（同提交共现最多的文件对）：");
    for (const c of coupling) lines.push(`  ${c.a}  ⇄  ${c.b}  ${c.together} 次`);
  }
  return lines.join("\n") + "\n";
}

export function formatDiff(result: DiffResult): string {
  const lines: string[] = [];
  const b = result.baseline;
  lines.push(`基线 ${b.commit.slice(0, 9)}（${b.reason}，${b.setAt.slice(0, 16)}）→ 当前 ${result.head.commit.slice(0, 9)}${result.head.branch ? " " + result.head.branch : ""}`);
  lines.push(`基线之后的提交：${result.commitsSince} 个；变更文件：${result.changes.length} 个（未提交 ${result.changes.filter((c) => !c.committed).length}）`);
  for (const d of changesByDir(result.changes)) lines.push(`  ${d.dir}/  ${d.files} 个文件${d.uncommitted ? `（${d.uncommitted} 未提交）` : ""}`);
  for (const c of result.changes.slice(0, 40)) lines.push(`    ${c.status} ${c.committed ? " " : "*"} ${c.path}`);
  if (result.changes.length > 40) lines.push(`    … 另 ${result.changes.length - 40} 个`);
  return lines.join("\n") + "\n";
}
