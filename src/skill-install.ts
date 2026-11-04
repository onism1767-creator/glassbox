/**
 * 把 skills/<名字>/SKILL.md 装进目标仓库的 .claude/skills/，并在开头生成「本项目怎么调用」：
 * 这台机器上多半没有 `glassbox` 命令，状态目录和 overlay 也不在仓库里；不写死这些，
 * 装进去的 skill 跑不起来，或者服务没开时把标注写进被观测仓库的 .workbench/。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SkillName = "glassbox-annotate" | "glassbox-journey";

export interface SkillInstallOptions {
  stateDir: string;
  overlayFile?: string;
  port: number;
}

const slash = (p: string) => path.resolve(p).split(path.sep).join("/");

/** 生成的那段：命令怎么敲、仓库在哪、状态目录和 overlay 是什么、服务开没开有什么区别。 */
export function projectHeader(root: string, o: SkillInstallOptions): string {
  const bin = slash(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "glassbox.js"));
  const tail = `--state "${slash(o.stateDir)}"${o.overlayFile ? ` --overlay "${slash(o.overlayFile)}"` : ""}`;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; // 本地日期，不用 UTC
  return [
    `## 本项目怎么调用（装 skill 时生成，${today}）`,
    "",
    "这台机器上没有 `glassbox` 命令，下面写 `glassbox` 的地方都换成：",
    "",
    "```bash",
    `node "${bin}"`,
    "```",
    "",
    `仓库是 \`${slash(root)}\`。每条命令末尾都加上状态目录${o.overlayFile ? "和 overlay" : ""}（标注和旅程都存在状态目录里，不写进仓库）：`,
    "",
    "```bash",
    tail,
    "```",
    "",
    `画布服务开着（http://127.0.0.1:${o.port}）时命令走服务，秒回，画布立刻更新；没开会本地索引一次（大仓库约半分钟）。`,
    "",
  ].join("\n");
}

/** 复制 SKILL.md 并把「本项目怎么调用」插在 front-matter 之后（front-matter 必须在最前面，Claude Code 才认）。总是从本仓库的原稿生成，重复装就是整文件重写。 */
export function installSkill(name: SkillName, root: string, o: SkillInstallOptions): string {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", name, "SKILL.md");
  const dst = path.join(root, ".claude", "skills", name, "SKILL.md");
  const raw = fs.readFileSync(src, "utf8");
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(raw);
  if (!m) throw new Error(`${src} 开头没有 front-matter`);
  const body = raw.slice(m[0].length).replace(/^\n+/, "\n");
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, m[0] + "\n" + projectHeader(root, o) + body, "utf8");
  return dst;
}
