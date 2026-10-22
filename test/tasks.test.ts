import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEmojiList, parseStandardTask, parseStage, compareStage } from "../src/tasks.ts";
import { computeProgress, computeGauge, findInconsistencies } from "../src/progress.ts";
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
  const s6 = tasks[1]!;
  assert.equal(s6.decided, "user");
  const s61 = tasks[2]!;
  assert.deepEqual(s61.files, ["crawler/render.py"]);
  assert.equal(s61.filesTier, "T1");
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

test("进度：文件改动与提交引用进信号，状态定区间，没信号不给百分比", () => {
  const tasks = parseEmojiList("docs/任务列表.md", sample);
  const s61 = tasks[2]!;
  const p = computeProgress(s61, commits, [{ path: "crawler/render.py", status: "M", committed: true }], {});
  assert.equal(p.percent, 100);
  assert.ok(p.signals.some((s) => s.name === "文件改动" && s.value === 1));
  assert.equal(p.commits.length, 1);
  const s8 = computeProgress(tasks[4]!, commits, [], {});
  assert.equal(s8.percent, undefined);
  assert.match(s8.formula, /没有任何机器可见的信号/);
});

test("阶段对照与不一致：文档说完成之后还有提交 → 完成后仍在改；代码跑到下一大步 → 文档落后", () => {
  const tasks = parseEmojiList("docs/任务列表.md", sample);
  const gauge = computeGauge(tasks, commits);
  assert.equal(gauge.doc.current, "S6");
  assert.equal(gauge.code.current, "S6.2");
  assert.equal(gauge.relation, "一致");
  const progress = new Map(tasks.map((t) => [t.id, computeProgress(t, commits, [], {})]));
  const inc = findInconsistencies(tasks, progress, gauge, Date.parse("2026-10-16T00:00:00+08:00"));
  assert.ok(inc.some((i) => i.taskId === "S6.1" && i.kind === "完成后仍在改"));
  const later = [{ sha: "c9", date: "2026-10-20T10:00:00+08:00", author: "a", subject: "feat(v0.1 S9.1): 新", stage: "v0.1 S9.1", files: [] }, ...commits];
  const g2 = computeGauge(tasks, later);
  assert.equal(g2.relation, "文档落后于代码");
  assert.match(g2.text, /S6 标为正在做/);
});

test("子任务与普通词编号：子任务全完成而父任务未改状态会被标出；「拍板」不去匹配提交", () => {
  const text = `- 🔨 **S6** 大步\n  - ✅ **S6.1** 小步一\n  - ✅ **S6.2** 小步二\n- ✅ **拍板** 定了\n`;
  const tasks = parseEmojiList("docs/任务列表.md", text);
  const s6 = tasks[0]!;
  const p = computeProgress(s6, commits, [], {}, Date.now(), tasks.filter((t) => t.parent === "S6"));
  assert.ok(p.signals.some((s) => s.name === "子任务" && s.value === 1));
  assert.equal(p.percent, 70);
  const progress = new Map(tasks.map((t) => [t.id, computeProgress(t, commits, [], {}, Date.now(), tasks.filter((k) => k.parent === t.id))]));
  const inc = findInconsistencies(tasks, progress, computeGauge(tasks, commits));
  assert.ok(inc.some((i) => i.taskId === "S6" && i.kind === "子任务都完成了"));
  const pb = progress.get("拍板")!;
  assert.equal(pb.commits.length, 0);
  assert.match(pb.signals.find((s) => s.name === "提交引用")?.text ?? "", /不像编号/);
});
