import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { indexRepository, type IndexResult } from "../src/index.ts";
import { parseArchitecture, compareArchitecture, buildArchitecture, guessArchitectureFile } from "../src/architecture.ts";

const fixtures = path.join(import.meta.dirname, "fixtures");
let result: IndexResult;

before(async () => {
  result = await indexRepository(path.join(fixtures, "mini-py"), { overlayFile: path.join(fixtures, "mini-py-overlay.yaml"), precise: false });
});

const doc = `# 小项目架构书

## 第 2 章 目录结构

\`\`\`
mini/
├── app/                 # 业务
│   ├── service.py       # 入口
│   └── models.py
├── core/
│   └── models.py        # 核心模型 Model
├── web/
│   └── nope.py          # 还没写
└── tests/
\`\`\`

## 第 6 章 接口

\`\`\`
interface Model:
    save() -> bool
    run(req) -> Model
\`\`\`

正文里提到 GhostModel 类还没写，CoreModel 也没有；用 FastAPI 和 PostgreSQL；\`util/text.py\` 做文本；\`render()\` 在 web 里；常量 \`NOT_OBSERVABLE\` 不算。
`;

test("抽取：目录树带路径、接口伪代码、反引号路径与函数、正文驼峰类；技术名和全大写不算；同一项多次提到只记一次", () => {
  const { declarations, headings } = parseArchitecture(doc, "ARCH.md", new Set(["fastapi"]));
  const names = declarations.map((d) => `${d.kind}:${d.name}`);
  assert.deepEqual(names, [
    "dir:app", "file:app/service.py", "file:app/models.py", "dir:core", "file:core/models.py", "dir:web", "file:web/nope.py", "dir:tests",
    "class:Model", "function:save", "function:run", "file:util/text.py", "function:render", "class:GhostModel", "class:CoreModel",
  ]);
  assert.equal(headings, 3);
  assert.equal(declarations.find((d) => d.name === "app/service.py")?.chapter, "第 2 章 目录结构");
  assert.equal(declarations.find((d) => d.name === "GhostModel")?.chapter, "第 6 章 接口");
  assert.equal(declarations.find((d) => d.name === "Model")?.mentions, 1);
  assert.ok(!names.includes("class:FastAPI") && !names.includes("class:PostgreSQL"));
});

test("对照：存在 / 缺失带代码位置和同名提示，落地率、按章节、多出的目录和类", () => {
  const parsed = parseArchitecture(doc, "ARCH.md", new Set(["fastapi"]));
  const a = compareArchitecture(parsed, { files: result.files, symbols: result.symbols }, "ARCH.md", doc);
  const st = Object.fromEntries(a.declarations.map((d) => [`${d.kind}:${d.name}`, d.status]));
  assert.equal(st["file:app/service.py"], "present");
  assert.equal(st["file:web/nope.py"], "missing");
  assert.equal(st["class:Model"], "present");
  assert.equal(st["function:run"], "present");
  assert.equal(st["class:GhostModel"], "missing");
  assert.equal(st["function:render"], "present");
  assert.equal(st["dir:tests"], "present");
  assert.equal(a.declarations.find((d) => d.name === "Model")?.found?.[0]?.path, "core/models.py");
  assert.equal(a.summary.declared, 13);
  assert.equal(a.declarations.find((d) => d.name === "GhostModel")?.weak, true);
  assert.deepEqual(a.weak.missing.map((w) => w.name), ["GhostModel", "CoreModel"]);
  assert.equal(a.summary.missing, a.declarations.filter((d) => d.status === "missing" && !d.weak).length);
  assert.equal(a.summary.rate, Math.round((a.summary.present / 13) * 1000) / 10);
  const ch6 = a.byChapter.find((c) => c.chapter === "第 6 章 接口")!;
  assert.deepEqual(ch6.missing, ["save"]);
  assert.ok(!a.extra.dirs.includes("app") && !a.extra.dirs.includes("util"));
  assert.ok(a.extra.classes.every((c) => c.name !== "Model"));
});

test("自动找架构书：根目录名字带「架构」或 architecture 的 .md", () => {
  const files = (names: string[]) => names.map((p) => ({ path: p, dir: ".", size: 1, hash: "x", language: "markdown", binary: false }));
  assert.equal(guessArchitectureFile(files(["README.md", "GEO工具项目架构书v0.4.md", "docs/架构.md"])), "GEO工具项目架构书v0.4.md");
  assert.equal(guessArchitectureFile(files(["README.md", "ARCHITECTURE.md"])), "ARCHITECTURE.md");
  assert.equal(guessArchitectureFile(files(["README.md"])), undefined);
  const a = buildArchitecture({ file: "ARCH.md", text: "# x\n`app/service.py`\n" }, { files: result.files, symbols: result.symbols });
  assert.equal(a.summary.rate, 100);
});
