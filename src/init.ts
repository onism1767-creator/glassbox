import fs from "node:fs";
import path from "node:path";
import { overlayPath, stateDir } from "./config.ts";

const TEMPLATE = `# glassbox overlay：解释层。这里写的都是声明（T2），画布会把它和代码事实并排显示。
version: 1

# 额外排除的路径或 glob（依赖目录、敏感文件已默认排除）
exclude: []

# Python 绝对导入的根目录；留空则自动探测 "." 与 "src"
# source_roots: [".", "src"]

# 分层：优先指向项目自己的守卫测试，让规则成为 T0
# layers:
#   from_guard_test:
#     file: tests/unit/test_layer_dependencies.py
#     layer_var: LAYER
#     allowed_var: ALLOWED
#   manual:            # 没有守卫测试时手写（T2）
#     adapters: 1
#     engine: 2
#     report: 3
#   allowed:
#     - { from: adapters, to: engine.models, note: 契约类型 }

# 零项目内依赖的包
# isolated_packages: [crawler]

# 某些目录下禁止出现的词；名单可从项目 YAML 动态取（T0）
# forbidden_words:
#   - dirs: [engine, diagnosis]
#     match: substring
#     words_from: { file: config/surfaces.yaml, list: surfaces, fields: [provider, name] }

# 提交信息里的阶段标签正则（默认匹配「v0.4.26 S9.3」这类写法）
# stage_tag: 'v\\d+(?:\\.\\d+)*\\s+S\\d+(?:\\.\\d+)?[a-z]?'
`;

export function initWorkspace(root: string): { overlayFile: string; created: boolean; excluded: boolean } {
  stateDir(root);
  const overlayFile = overlayPath(root);
  let created = false;
  if (!fs.existsSync(overlayFile)) {
    fs.writeFileSync(overlayFile, TEMPLATE, "utf8");
    created = true;
  }
  let excluded = false;
  const gitDir = path.join(root, ".git");
  if (fs.existsSync(gitDir)) {
    let dir = gitDir;
    if (fs.statSync(gitDir).isFile()) {
      const pointer = fs.readFileSync(gitDir, "utf8").trim().replace(/^gitdir:\s*/, "");
      dir = path.resolve(root, pointer);
    }
    const excludeFile = path.join(dir, "info", "exclude");
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
    if (!current.split(/\r?\n/).includes("/.workbench/")) {
      fs.appendFileSync(excludeFile, (current.endsWith("\n") || !current ? "" : "\n") + "/.workbench/\n");
      excluded = true;
    }
  }
  return { overlayFile, created, excluded };
}
