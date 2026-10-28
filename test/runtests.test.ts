import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeCoverageIni, mergeCoverageToml, buildCoverageConfig, DEFAULT_COVERAGE_BASE, probeModule, runCommand } from "../src/runtests.ts";

const count = (text: string, rx: RegExp) => (text.match(rx) ?? []).length;

test("coverage 配置：.coveragerc 的 source / omit / report 保留，我们的三项叠上去，同名键只留我们的", () => {
  const out = mergeCoverageIni("[run]\nsource = src\nbranch = True\ndynamic_context = none\n\n[report]\nskip_empty = True\n", false);
  assert.match(out, /\[run\]\nsource = src\nbranch = True\n/);
  assert.equal(count(out, /dynamic_context/g), 1);
  assert.match(out, /dynamic_context = test_function\nrelative_files = True/);
  assert.match(out, /\[report\]\nskip_empty = True/);
  assert.match(out, /\[json\]\nshow_contexts = True/);
});

test("coverage 配置：setup.cfg 只取 [coverage:*] 段，别的工具的段不带", () => {
  const out = mergeCoverageIni("[metadata]\nname = x\n[coverage:run]\nomit = tests/*\n[coverage:report]\nfail_under = 80\n[tool:pytest]\naddopts = -q\n", true);
  assert.match(out, /\[run\]\nomit = tests\/\*/);
  assert.match(out, /\[report\]\nfail_under = 80/);
  assert.doesNotMatch(out, /metadata|tool:pytest/);
  assert.match(out, /relative_files = True/);
});

test("coverage 配置：pyproject 的 [tool.coverage.*] 抄出来叠上我们的；多行数组不受影响；裸 [tool.coverage] 用内联表的放弃合并", () => {
  const toml = `[build-system]\nrequires = ["x"]\n\n[tool.coverage.run]\nsource = ["src"]\nomit = [\n  "tests/*",\n]\ndynamic_context = "none"\n\n[tool.coverage.report]\nfail_under = 80\n\n[[tool.something]]\na = 1\n\n[tool.ruff]\nline-length = 120\n`;
  const out = mergeCoverageToml(toml)!;
  assert.match(out, /\[tool\.coverage\.run\]\nsource = \["src"\]\nomit = \[\n  "tests\/\*",\n\]/);
  assert.equal(count(out, /dynamic_context/g), 1);
  assert.match(out, /dynamic_context = "test_function"\nrelative_files = true/);
  assert.match(out, /\[tool\.coverage\.report\]\nfail_under = 80/);
  assert.match(out, /\[tool\.coverage\.json\]\nshow_contexts = true/);
  assert.doesNotMatch(out, /build-system|tool\.ruff|tool\.something|a = 1/);
  assert.equal(mergeCoverageToml("[tool.coverage]\nrun = { branch = true }\n"), undefined);
});

test("coverage 配置：按 coverage 的查找顺序挑项目的配置；没有就用 glassbox 缺省", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glassbox-cov-"));
  try {
    assert.equal(buildCoverageConfig(root).base, DEFAULT_COVERAGE_BASE);
    fs.writeFileSync(path.join(root, "pyproject.toml"), "[tool.pytest.ini_options]\ntestpaths = ['tests']\n");
    assert.equal(buildCoverageConfig(root).base, DEFAULT_COVERAGE_BASE);
    fs.writeFileSync(path.join(root, "pyproject.toml"), "[tool.coverage.run]\nbranch = true\n");
    const py = buildCoverageConfig(root);
    assert.equal(py.file, "coverage.toml");
    assert.match(py.base, /pyproject/);
    assert.match(py.text, /branch = true/);
    fs.writeFileSync(path.join(root, ".coveragerc"), "[run]\nsource = app\n");
    const rc = buildCoverageConfig(root);
    assert.equal(rc.file, "coveragerc");
    assert.match(rc.base, /\.coveragerc/);
    assert.match(rc.text, /source = app/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("解释器探测：路径不存在是「找不到解释器」，有解释器没模块是「没有模块」", async () => {
  assert.equal(await probeModule(path.join(os.tmpdir(), "glassbox-no-such-python.exe"), "pytest", os.tmpdir()), "no-interpreter");
  // node 当假解释器：-c "import x" 它读不懂，退出码非零 → missing
  assert.equal(await probeModule(process.execPath, "pytest", os.tmpdir()), "missing");
});

test("跑命令：超时会终止并报错", async () => {
  const started = Date.now();
  await assert.rejects(runCommand(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], os.tmpdir(), process.env, undefined, 300), /超过/);
  assert.ok(Date.now() - started < 5000);
});
