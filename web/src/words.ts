/** 画布上所有文字的统一出处：人话在前，专业术语放括号里。 */
import type { ChangeRecord } from "../../src/types.ts";

export interface Names {
  layers: Record<string, string>;
  dirs: Record<string, string>;
}

export const EMPTY_NAMES: Names = { layers: {}, dirs: {} };

export function tierText(t: string): string {
  switch (t) {
    case "T0":
      return "机器直接看到的（T0 观测）";
    case "T1":
      return "机器算出来的（T1 推导）";
    case "T2":
      return "人或 AI 写的（T2 声明）";
    case "T3":
      return "机器验证过的（T3 验证）";
    default:
      return t;
  }
}

export function resolutionText(r: string): string {
  switch (r) {
    case "same-file":
      return "同一个文件里找到的（same-file）";
    case "import":
      return "顺着 import 找到的（import）";
    case "self":
      return "调自己类里的方法（self）";
    case "pyright":
      return "类型分析器推断的（pyright）";
    default:
      return r;
  }
}

export function unresolvedKindText(k: string): string {
  switch (k) {
    case "builtin":
      return "语言自带的函数（内置）";
    case "external":
      return "第三方库的函数（外部库）";
    case "needs-types":
      return "要知道变量类型才能确定（需要类型信息）";
    case "inherited":
      return "可能是父类的方法（继承）";
    case "unknown-name":
      return "名字来历不明（未知名字）";
    case "complex":
      return "表达式太复杂没法静态判断（复杂表达式）";
    default:
      return k;
  }
}

export function changeWord(status: ChangeRecord["status"] | "clean", uncommitted: boolean): string {
  const base = status === "A" ? "新增" : status === "M" ? "修改" : status === "D" ? "删除" : status === "R" ? "重命名" : status === "?" ? "新文件还没进版本（未跟踪）" : "没变";
  if (status === "?" || status === "clean") return base;
  return uncommitted ? `${base}了，还没提交` : `${base}了`;
}

export function kindWord(kind: string): string {
  return kind === "class" ? "类" : kind === "method" ? "方法" : "函数";
}

/** 目录的人话名：「报告和网页（report）」；没有人话名就只给目录名。 */
export function dirLabel(dir: string, names: Names): string {
  const human = names.dirs[dir];
  if (dir === ".") return human ? `${human}（根目录）` : "根目录";
  return human ? `${human}（${dir}）` : dir;
}

export function dirShort(dir: string, names: Names): string {
  return names.dirs[dir] ?? (dir === "." ? "根目录" : dir);
}

/** 层的人话名：「第 4 层 · 给用户看的报告和网页（L4 report）」。 */
export function layerLabel(layer: number, dirs: string[], names: Names): string {
  const human = names.layers[String(layer)];
  const tech = `L${layer}${dirs.length ? " " + dirs.join("、") : ""}`;
  return human ? `第 ${layer} 层 · ${human}（${tech}）` : `第 ${layer} 层（${tech}）`;
}

export function layerBadge(layer: number, names: Names): string {
  const human = names.layers[String(layer)];
  return human ? `第 ${layer} 层 ${human}（L${layer}）` : `第 ${layer} 层（L${layer}）`;
}

export function sourceWord(source: string): string {
  switch (source) {
    case "hook":
      return "Claude 的动作（hook）";
    case "watcher":
      return "文件变了（监听）";
    case "git":
      return "有新提交（git）";
    default:
      return "系统";
  }
}

export function sourceShort(source: string): string {
  switch (source) {
    case "hook":
      return "Claude";
    case "watcher":
      return "文件";
    case "git":
      return "git";
    default:
      return "系统";
  }
}

export function statusWord(s: string): string {
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
    default:
      return s;
  }
}

export const WORDS = {
  violations: (n: number) => (n ? `越层调用 ${n} 处（分层违规）` : "没有越层调用（分层违规 0）"),
  allowed: (n: number) => `明文允许的例外 ${n} 处（白名单放行）`,
  importEdge: (n: number) => `${n} 处 import`,
  importEdgeViolations: (n: number, v: number) => `${n} 处 import · 越层 ${v}`,
  importEdgeAllowed: (n: number, a: number) => `${n} 处 import · 白名单 ${a}`,
  symbols: (n: number) => `${n} 个函数或类（符号）`,
  touched: (n: number) => `Claude 刚改过 ${n} 个`,
  changedFiles: (n: number, uncommitted: number) => `这次会话改了 ${n} 个文件${uncommitted ? `，${uncommitted} 个还没提交` : ""}（相对基线）`,
  callers: (n: number) => `被别人调用 ${n} 次（调用者）`,
  unresolved: (n: number) => `有 ${n} 处看不出调用了谁（未解析）`,
  stage: (s: string) => `代码做到了 ${s}（提交信息里的阶段标签）`,
  baseline: (commits: number, files: number) => `这次会话以来提交 ${commits} 次、改了 ${files} 个文件（相对基线）`,
  noBaseline: "没有记录会话起点（无基线）",
  liveOn: "画布跟代码同步中（实时）",
  liveOff: "没连上实时推送（离线）",
};
