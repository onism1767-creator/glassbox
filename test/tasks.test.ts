import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEmojiList, parseStandardTask, parseStage, compareStage } from "../src/tasks.ts";
import { computeAllProgress, computeGauge, findInconsistencies } from "../src/progress.ts";
import type { CommitRecord } from "../src/types.ts";

const sample = `# 任务列表

## 实施顺序

- ✅ **S1** 删 Perplexity 搜索接口(M5;2026-10-12):适配器、配置行全部删除。验收:285 测试全绿
- 🔨 **S6** 第三方线 = 原竖条 ②(S6.1 已完成;用户 2026-10-13 拍板):
  - ✅ **S6.1**(2026-10-13;307 测试全绿)正文核实挪到 L2,新模块 \`crawler/render.py\`
  - ⏳ **S6.2** 浏览器渲染回退(Claude 提议)
- ⏳ **S8** 报告与输出:采样说明、单条回答页
`;

test("emoji 列表：编号、状态、标题、嵌套、日期、拍板、验收声明、反引号文件", () => {
  const tasks = parseEmojiList("docs/任务列表.md", sample);
  assert.deepEqual(tasks.map((t) => [t.id, t.status, t.parent ?? null]), [["S1", "done", null], ["S6", "developing", null], ["S6.1", "done", "S6"], ["S6.2", "todo", "S6"], ["S8", "todo", null]]);
  const s1 = tasks[0]!;
  assert.equal(s1.title, "删 Perplexity 搜索接口");
  assert.equal(s1.dates.last, "2026-10-12");
  assert.equal(s1.testsClaimed, 285);
  assert.equal(s1.source.line, 5);
  assert.equal(tasks[1]?.decided, "user");
  assert.deepEqual(tasks[2]?.files, ["crawler/render.py"]);
  assert.equal(tasks[2]?.filesTier, "T1");
  assert.equal(tasks[3]?.decided, "claude");
  assert.deepEqual(parseStage("S6.2b"), { major: 6, minor: 2, suffix: "b", text: "S6.2b" });
  assert.ok(compareStage(parseStage("S10")!, parseStage("S9.3")!) > 0);
});

test("standard 格式：front-matter 与复选框", () => {
  const t = parseStandardTask(".workbench/tasks/T-1.md", `---\nid: T-1\ntitle: 做个东西\nstatus: developing\nfiles: [a.py, b.py]\ndepends_on: [T-0]\n---\n## 验收标准\n- [x] 第一条\n- [ ] 第二条\n`);
  assert.equal(t?.id, "T-1");
  assert.equal(t?.status, "developing");
  assert.deepEqual(t?.files, ["a.py", "b.py"]);
  assert.deepEqual(t?.criteria, [{ text: "第一条", done: true }, { text: "第二条", done: false }]);
  assert.equal(t?.filesTier, "T2");
});

const commits: CommitRecord[] = [
  { sha: "c3", date: "2026-10-15T10:00:00+08:00", author: "a", subject: "feat(v0.1 S6.2): 回退", stage: "v0.1 S6.2", files: [] },
  { sha: "c2", date: "2026-10-14T10:00:00+08:00", author: "a", subject: "fix(v0.1 S6.1): 补", stage: "v0.1 S6.1", files: [] },
  { sha: "c1", date: "2026-10-12T10:00:00+08:00", author: "a", subject: "feat(v0.1 S1): 删", stage: "v0.1 S1", files: [] },
];
const now = Date.parse("2026-10-16T00:00:00+08:00");

test("状态以代码为准：后面的阶段已打标签 → 完成；代码正标在这一步 → 正在做；没痕迹 → 只能照文档", () => {
  const tasks = parseEmojiList("docs/任务列表.md", sample);
  const all = computeAllProgress(tasks, { commits, changes: [], touched: {}, now });
  assert.equal(all.get("S1")?.derived.status, "done");
  assert.equal(all.get("S1")?.derived.certainty, "确定");
  assert.equal(all.get("S6.1")?.derived.status, "done");
  assert.equal(all.get("S6.2")?.derived.status, "developing");
  assert.equal(all.get("S6.2")?.docStatus, "todo");
  assert.equal(all.get("S6")?.derived.status, "developing");
  assert.match(all.get("S6")?.derived.basis ?? "", /子任务/);
  assert.equal(all.get("S8")?.derived.certainty, "只有文档说法");
  assert.equal(all.get("S8")?.derived.status, "todo");
  assert.equal(all.get("S1")?.percent, 100);
  assert.equal(all.get("S6.2")?.percent, 10);
});

test("父任务：子任务按代码都完成了 → 父任务完成，哪怕文档还写正在做", () => {
  const later: CommitRecord[] = [{ sha: "c9", date: "2026-10-20T10:00:00+08:00", author: "a", subject: "feat(v0.1 S9.1): 新", stage: "v0.1 S9.1", files: [] }, ...commits];
  const tasks = parseEmojiList("docs/任务列表.md", sample);
  const all = computeAllProgress(tasks, { commits: later, changes: [], touched: {}, now: Date.parse("2026-10-21T00:00:00+08:00") });
  assert.equal(all.get("S6.2")?.derived.status, "done");
  assert.equal(all.get("S6")?.derived.status, "done");
  const gauge = computeGauge(tasks, later, all);
  assert.equal(gauge.code.current, "S9.1");
  assert.equal(gauge.code.derivedDone, 4);
  assert.ok(gauge.stale >= 2);
  const inc = findInconsistencies(tasks, all, gauge, Date.parse("2026-10-21T00:00:00+08:00"));
  const s6 = inc.find((i) => i.taskId === "S6" && i.kind === "文档没更新");
  assert.ok(s6 && s6.severity === "info");
  assert.ok(inc.some((i) => i.taskId === "S6.1" && i.kind === "标完成后还有提交" && i.severity === "info"));
});

test("普通词编号不匹配提交；编号重复会被标出", () => {
  const text = `- ✅ **拍板** 定了\n- ⏳ **S10** 甲\n- ⏳ **S10** 乙\n`;
  const tasks = parseEmojiList("docs/任务列表.md", text);
  const all = computeAllProgress(tasks, { commits, changes: [], touched: {}, now });
  assert.equal(all.get("拍板")?.commits.length, 0);
  assert.match(all.get("拍板")?.signals.find((s) => s.name === "提交引用")?.text ?? "", /不像编号/);
  const inc = findInconsistencies(tasks, all, computeGauge(tasks, commits, all), now);
  assert.ok(inc.some((i) => i.kind === "编号重复" && i.taskId === "S10"));
});
