/** 真相等级：T0 观测、T1 推导、T2 声明、T3 机器验证。 */
export type Tier = "T0" | "T1" | "T2" | "T3";

export interface Evidence {
  path: string;
  line?: number;
  note?: string;
}

export interface FileRecord {
  path: string;
  dir: string;
  size: number;
  hash: string;
  language: string;
  binary: boolean;
}

export type ImportStatus = "resolved" | "external" | "unresolved";

export interface ImportedName {
  /** 目标里的原名；module 与 namespace 类型时为空字符串。 */
  name: string;
  /** 本文件里用的名字。 */
  alias: string;
  kind: "named" | "default" | "namespace" | "module";
}

export interface ImportRecord {
  from: string;
  spec: string;
  line: number;
  /** Python 相对导入的点数；绝对导入为 0。 */
  level: number;
  status: ImportStatus;
  resolved?: string;
  reason?: string;
  /** 这条语句把哪些名字带进了本文件。 */
  names?: ImportedName[];
}

export type SymbolKind = "function" | "class" | "method";

export interface SymbolRecord {
  /** `路径::限定名`，全局唯一。 */
  id: string;
  path: string;
  kind: SymbolKind;
  name: string;
  /** 文件内限定名，如 Tool.run、outer.inner。 */
  qualified: string;
  parent?: string;
  startLine: number;
  endLine: number;
  exported?: boolean;
  isDefault?: boolean;
  /** 这个函数或类自己源码的哈希（标注绑定用）。 */
  hash?: string;
}

export type CallResolution = "same-file" | "import" | "self" | "pyright";

export interface CallEdge {
  /** 调用者符号 id；模块顶层代码记为 `路径::<module>`。 */
  from: string;
  to: string;
  evidence: Evidence;
  resolution: CallResolution;
}

export type UnresolvedKind = "needs-types" | "builtin" | "external" | "unknown-name" | "complex" | "inherited";

export interface UnresolvedCall {
  path: string;
  line: number;
  /** 被调用名字最后一段的起始列（0 起），给精确层定位用。 */
  col: number;
  callee: string;
  from: string;
  kind: UnresolvedKind;
  reason: string;
}

export interface FileEdge {
  from: string;
  to: string;
  kind: "import";
  evidence: Evidence[];
}

export interface LayerRules {
  /** 包名 → 层级数字，数字大者为上层。 */
  layers: Record<string, number>;
  /** 允许的「下层用上层」例外：from 包、to 模块前缀。 */
  allowed: { from: string; to: string; source?: Evidence }[];
  /** 零项目内依赖的包。 */
  isolated: { pkg: string; source?: Evidence }[];
  /** 某些目录下禁止出现的词。 */
  forbiddenWords: { dirs: string[]; words: string[]; match: "substring" | "word"; source?: Evidence }[];
  /** 规则来自哪里。 */
  provenance: { what: string; tier: Tier; evidence?: Evidence }[];
}

export interface Violation {
  rule: "layer-direction" | "isolated-package" | "forbidden-word";
  from: string;
  to?: string;
  evidence: Evidence;
  message: string;
}

export interface AllowedEdge {
  from: string;
  to: string;
  evidence: Evidence;
  allowedBy?: Evidence;
}

export interface CommitRecord {
  sha: string;
  date: string;
  author: string;
  subject: string;
  stage?: string;
  files: { path: string; added: number; deleted: number }[];
}

export interface Baseline {
  commit: string;
  branch: string | null;
  setAt: string;
  reason: string;
}

export interface ChangeRecord {
  path: string;
  status: "A" | "M" | "D" | "R" | "?";
  committed: boolean;
}

export interface ActivityEvent {
  id: number;
  at: string;
  source: "hook" | "watcher" | "git" | "system";
  /** 如 SessionStart、PostToolUse、file-change、recompute、baseline。 */
  kind: string;
  session?: string;
  tool?: string;
  path?: string;
  text: string;
}

export interface Touch {
  at: string;
  session?: string;
  tool?: string;
}
