/** `glassbox test`：用项目自己的解释器跑 pytest，把 junit（和 coverage）写进状态目录。 */
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { guessPythonPath } from "./pyright.ts";
import { compactCoverage } from "./tests.ts";

export interface RunTestsOptions {
  stateDir: string;
  /** 解释器；缺省找仓库的 .venv。 */
  python?: string;
  coverage?: boolean;
  extraArgs?: string[];
  log?: (line: string) => void;
}

export interface RunTestsResult {
  python: string;
  junit: string;
  coverage?: string;
  /** 覆盖率按哪份配置算的（人话）。 */
  coverageConfig?: string;
  exitCode: number;
  elapsedMs: number;
  tail: string;
  coverageSkipped?: string;
}

/** 超时了把整棵进程树杀掉：只杀 python 主进程会留下 pytest-xdist 之类的子进程。 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    k.on("error", () => child.kill());
    return;
  }
  child.kill("SIGTERM");
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 2000);
  t.unref();
}

export function runCommand(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log?: (l: string) => void, timeoutMs = 600_000): Promise<{ code: number; tail: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let tail = "";
    const keep = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      log?.(text.replace(/\s+$/, ""));
      tail = (tail + text).slice(-4000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      killTree(child);
      reject(new Error(`超过 ${timeoutMs / 1000} 秒，已终止`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, tail });
    });
  });
}

export type ProbeResult = "ok" | "missing" | "no-interpreter";

/** 解释器里有没有这个模块；解释器本身不存在是另一回事，提示要分开。 */
export async function probeModule(python: string, mod: string, cwd: string): Promise<ProbeResult> {
  if (path.isAbsolute(python) && !fs.existsSync(python)) return "no-interpreter";
  try {
    const { code } = await runCommand(python, ["-c", `import ${mod}`], cwd, process.env, undefined, 30_000);
    return code === 0 ? "ok" : "missing";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "EACCES" ? "no-interpreter" : "missing";
  }
}

export interface CoverageConfigPlan {
  /** 写到状态目录里的文件名：INI 叫 coveragerc，TOML 叫 coverage.toml（coverage 按后缀认格式）。 */
  file: "coveragerc" | "coverage.toml";
  text: string;
  /** 人话：按哪份配置算的。 */
  base: string;
}

const OUR_INI_RUN = ["dynamic_context = test_function", "relative_files = True"];
const OUR_INI_JSON = ["show_contexts = True"];
const OUR_TOML_RUN = ['dynamic_context = "test_function"', "relative_files = true"];
const OUR_TOML_JSON = ["show_contexts = true"];
const OUR_RUN_KEYS = /^\s*(?:dynamic_context|relative_files)\s*[=:]/;
const OUR_JSON_KEYS = /^\s*show_contexts\s*[=:]/;

export const DEFAULT_COVERAGE_BASE = "glassbox 缺省配置（项目没有 coverage 配置，测试文件也计入）";

export function defaultCoverageConfig(): CoverageConfigPlan {
  return { file: "coveragerc", text: `[run]\n${OUR_INI_RUN.join("\n")}\n[json]\n${OUR_INI_JSON.join("\n")}\n`, base: DEFAULT_COVERAGE_BASE };
}

interface Block {
  name: string;
  lines: string[];
}

function ensureBlock(blocks: Block[], name: string): Block {
  let b = blocks.find((x) => x.name === name);
  if (!b) {
    b = { name, lines: [] };
    blocks.push(b);
  }
  return b;
}

/** INI 格式（.coveragerc 的 [run]，或 setup.cfg / tox.ini 的 [coverage:run]）：只取 coverage 的段，去掉我们要覆盖的键，再加上我们的。 */
export function mergeCoverageIni(text: string, onlyPrefixed: boolean): string {
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (h) {
      const full = (h[1] ?? "").trim();
      const prefixed = full.startsWith("coverage:");
      current = !onlyPrefixed || prefixed ? ensureBlock(blocks, prefixed ? full.slice("coverage:".length) : full) : null;
      continue;
    }
    if (current) current.lines.push(line);
  }
  const run = ensureBlock(blocks, "run");
  run.lines = [...run.lines.filter((l) => !OUR_RUN_KEYS.test(l)), ...OUR_INI_RUN];
  const json = ensureBlock(blocks, "json");
  json.lines = [...json.lines.filter((l) => !OUR_JSON_KEYS.test(l)), ...OUR_INI_JSON];
  return blocks.map((b) => `[${b.name}]\n${b.lines.join("\n")}`).join("\n") + "\n";
}

/** pyproject.toml 的 [tool.coverage.*]：抄出这些表，去掉我们要覆盖的键，再加上我们的。叠不进去（裸 [tool.coverage] 里用内联表写 run = {...}）就返回 undefined。 */
export function mergeCoverageToml(text: string): string | undefined {
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[\[/.test(line)) {
      current = null;
      continue;
    }
    const h = /^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (h) {
      const name = (h[1] ?? "").replace(/\s/g, "");
      current = name === "tool.coverage" || name.startsWith("tool.coverage.") ? ensureBlock(blocks, name) : null;
      continue;
    }
    if (current) current.lines.push(line);
  }
  const bare = blocks.find((b) => b.name === "tool.coverage");
  if (bare && bare.lines.some((l) => /^\s*(?:run|json)\s*=/.test(l))) return undefined;
  const run = ensureBlock(blocks, "tool.coverage.run");
  run.lines = [...run.lines.filter((l) => !OUR_RUN_KEYS.test(l)), ...OUR_TOML_RUN];
  const json = ensureBlock(blocks, "tool.coverage.json");
  json.lines = [...json.lines.filter((l) => !OUR_JSON_KEYS.test(l)), ...OUR_TOML_JSON];
  return blocks.map((b) => `[${b.name}]\n${b.lines.join("\n")}`).join("\n") + "\n";
}

/**
 * 项目自己的 coverage 配置（按 coverage 的查找顺序：.coveragerc、setup.cfg、tox.ini、pyproject.toml）叠上我们要的三项：
 * 记每个测试跑过哪些行、路径相对化、json 带上下文。这样 source / omit / branch 都按项目的来，数字和项目 CI 对得上。
 */
export function buildCoverageConfig(root: string): CoverageConfigPlan {
  const read = (name: string): string | undefined => {
    try {
      return fs.readFileSync(path.join(root, name), "utf8");
    } catch {
      return undefined;
    }
  };
  const rc = read(".coveragerc");
  if (rc !== undefined) return { file: "coveragerc", text: mergeCoverageIni(rc, false), base: "项目的 .coveragerc，加上「每个测试跑过哪些行」" };
  for (const name of ["setup.cfg", "tox.ini"]) {
    const text = read(name);
    if (text !== undefined && /^\s*\[coverage:/m.test(text)) return { file: "coveragerc", text: mergeCoverageIni(text, true), base: `项目的 ${name}（[coverage:*]），加上「每个测试跑过哪些行」` };
  }
  const py = read("pyproject.toml");
  if (py !== undefined && /^\s*\[tool\.coverage(?:\.|\])/m.test(py)) {
    const merged = mergeCoverageToml(py);
    if (merged !== undefined) return { file: "coverage.toml", text: merged, base: "项目的 pyproject.toml（[tool.coverage]），加上「每个测试跑过哪些行」" };
  }
  return defaultCoverageConfig();
}

export async function runTests(root: string, options: RunTestsOptions): Promise<RunTestsResult> {
  const started = Date.now();
  const python = options.python ?? guessPythonPath(root) ?? "python";
  const dir = path.join(options.stateDir, "test-results");
  fs.mkdirSync(dir, { recursive: true });
  const junit = path.join(dir, "junit.xml");
  const coverageJson = path.join(dir, "coverage.json");
  const pytestArgs = ["-p", "no:cacheprovider", "-q", `--junitxml=${junit}`, ...(options.extraArgs ?? [])];
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
  const probe = await probeModule(python, "pytest", root);
  if (probe === "no-interpreter") throw new Error(`找不到 Python 解释器：${python}`);
  if (probe === "missing") throw new Error(`${python} 里没有 pytest`);
  const wantCoverage = options.coverage !== false;
  const hasCoverage = wantCoverage && (await probeModule(python, "coverage", root)) === "ok";
  let coverageSkipped: string | undefined;
  let coverageConfig: string | undefined;
  let exitCode: number;
  let tail: string;
  if (hasCoverage) {
    let plan = buildCoverageConfig(root);
    let rc = path.join(dir, plan.file);
    fs.writeFileSync(rc, plan.text, "utf8");
    const covEnvFor = (file: string) => ({ ...env, COVERAGE_FILE: path.join(dir, ".coverage"), COVERAGE_RCFILE: file });
    if (plan.base !== DEFAULT_COVERAGE_BASE) {
      // 叠出来的配置先让 coverage 自己读一遍；读不了就退回缺省配置，不能让测试跑不起来。
      const check = await runCommand(python, ["-m", "coverage", "debug", "config"], root, covEnvFor(rc), undefined, 60_000);
      if (check.code !== 0) {
        options.log?.(`项目的 coverage 配置叠不上，改用 glassbox 缺省配置：${check.tail.trim().split("\n").slice(-1)[0] ?? ""}`);
        plan = { ...defaultCoverageConfig(), base: `${DEFAULT_COVERAGE_BASE.replace("项目没有 coverage 配置", "项目的配置叠不上")}` };
        rc = path.join(dir, plan.file);
        fs.writeFileSync(rc, plan.text, "utf8");
      }
    }
    coverageConfig = plan.base;
    const covEnv = covEnvFor(rc);
    options.log?.(`跑测试（带覆盖率，${plan.base}）：${python} -m coverage run -m pytest ${pytestArgs.join(" ")}`);
    const r = await runCommand(python, ["-m", "coverage", "run", "-m", "pytest", ...pytestArgs], root, covEnv, options.log);
    exitCode = r.code;
    tail = r.tail;
    const raw = path.join(dir, "coverage-raw.json");
    const j = await runCommand(python, ["-m", "coverage", "json", "-o", raw, "--show-contexts", "-q"], root, covEnv, options.log, 120_000);
    if (j.code !== 0) coverageSkipped = `coverage json 失败：${j.tail.slice(-300)}`;
    else {
      // 带上下文的原始文件动辄几十 MB，压成只含摘要和「跑过它的测试」的小文件，原始文件删掉。
      const tmp = coverageJson + ".tmp";
      fs.writeFileSync(tmp, compactCoverage(fs.readFileSync(raw, "utf8"), { config: plan.base }), "utf8");
      fs.renameSync(tmp, coverageJson);
      fs.rmSync(raw, { force: true });
      options.log?.(`覆盖率已压缩：${(fs.statSync(coverageJson).size / 1024).toFixed(0)} KB`);
    }
  } else {
    if (wantCoverage) coverageSkipped = `这个解释器里没有 coverage，只写了 junit；想要覆盖率和「每个测试跑过哪些文件」，在项目的环境里 pip install coverage`;
    options.log?.(`跑测试：${python} -m pytest ${pytestArgs.join(" ")}`);
    const r = await runCommand(python, ["-m", "pytest", ...pytestArgs], root, env, options.log);
    exitCode = r.code;
    tail = r.tail;
  }
  return { python, junit, ...(hasCoverage && !coverageSkipped ? { coverage: coverageJson } : {}), ...(coverageConfig ? { coverageConfig } : {}), exitCode, elapsedMs: Date.now() - started, tail, ...(coverageSkipped ? { coverageSkipped } : {}) };
}
