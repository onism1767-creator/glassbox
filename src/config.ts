import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export interface GuardTestRef {
  file: string;
  layer_var?: string;
  allowed_var?: string;
}

export interface Overlay {
  version: 1;
  exclude: string[];
  /** Python 绝对导入的根目录，相对仓库；缺省自动探测。 */
  source_roots?: string[];
  layers?: {
    from_guard_test?: GuardTestRef;
    manual?: Record<string, number>;
    allowed?: { from: string; to: string; note?: string }[];
  };
  isolated_packages?: string[];
  forbidden_words?: ForbiddenWordsRule[];
  /** 提交信息里的阶段标签正则。 */
  stage_tag?: string;
  /** 人话名字（T2 声明）：层号 → 名字，目录 → 名字。 */
  names?: { layers?: Record<string, string>; dirs?: Record<string, string> };
  /** 项目已有的任务列表文件；没有就用 .workbench/tasks/*.md。 */
  tasks?: { file: string; format?: "emoji-list" | "standard" };
}

export interface WordsFromYaml {
  file: string;
  /** 顶层列表的键名，如 surfaces。 */
  list: string;
  /** 每一项里取哪些字段的值当作词。 */
  fields: string[];
  /** 某字段按分隔符拆词，排除通用词。 */
  split?: { field: string; sep: string; exclude?: string[] };
}

export interface ForbiddenWordsRule {
  dirs: string[];
  /** substring：子串匹配（默认）；word：整词匹配。 */
  match?: "substring" | "word";
  words?: string[];
  words_from?: WordsFromYaml;
  source?: string;
}

export const STATE_DIR = ".workbench";

export function defaultOverlay(): Overlay {
  return { version: 1, exclude: [] };
}

export function overlayPath(root: string): string {
  return path.join(root, STATE_DIR, "overlay.yaml");
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : undefined;
}

export function readOverlay(root: string, override?: string): Overlay {
  const file = override ? path.resolve(override) : overlayPath(root);
  if (!fs.existsSync(file)) return defaultOverlay();
  const raw: unknown = parseYaml(fs.readFileSync(file, "utf8"));
  if (!raw || typeof raw !== "object") return defaultOverlay();
  const o = raw as Partial<Overlay>;
  return {
    version: 1,
    exclude: stringList(o.exclude) ?? [],
    source_roots: stringList(o.source_roots),
    layers: o.layers,
    isolated_packages: stringList(o.isolated_packages),
    forbidden_words: o.forbidden_words,
    stage_tag: typeof o.stage_tag === "string" ? o.stage_tag : undefined,
    names: o.names && typeof o.names === "object" ? { layers: stringMap(o.names.layers), dirs: stringMap(o.names.dirs) } : undefined,
    tasks: o.tasks && typeof o.tasks === "object" && typeof o.tasks.file === "string" ? { file: o.tasks.file, format: o.tasks.format === "standard" ? "standard" : "emoji-list" } : undefined,
  };
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === "string") out[String(k)] = v;
  return out;
}

export function stateDir(root: string): string {
  const dir = path.join(root, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
