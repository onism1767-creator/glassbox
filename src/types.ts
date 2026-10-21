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

export interface ImportRecord {
  from: string;
  spec: string;
  line: number;
  /** Python 相对导入的点数；绝对导入为 0。 */
  level: number;
  status: ImportStatus;
  resolved?: string;
  reason?: string;
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
