/** `glassbox test`：用项目自己的解释器跑 pytest，把 junit（和 coverage）写进状态目录。 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
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
  exitCode: number;
  elapsedMs: number;
  tail: string;
  coverageSkipped?: string;
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
      child.kill();
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

export async function moduleAvailable(python: string, mod: string, cwd: string): Promise<boolean> {
  try {
    const { code } = await runCommand(python, ["-c", `import ${mod}`], cwd, process.env, undefined, 30_000);
    return code === 0;
  } catch {
    return false;
  }
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
  if (!(await moduleAvailable(python, "pytest", root))) throw new Error(`${python} 里没有 pytest`);
  const wantCoverage = options.coverage !== false;
  const hasCoverage = wantCoverage && (await moduleAvailable(python, "coverage", root));
  let coverageSkipped: string | undefined;
  let exitCode: number;
  let tail: string;
  if (hasCoverage) {
    const rc = path.join(dir, "coveragerc");
    fs.writeFileSync(rc, "[run]\ndynamic_context = test_function\nrelative_files = True\n[json]\nshow_contexts = True\n", "utf8");
    const covEnv = { ...env, COVERAGE_FILE: path.join(dir, ".coverage"), COVERAGE_RCFILE: rc };
    options.log?.(`跑测试（带覆盖率）：${python} -m coverage run -m pytest ${pytestArgs.join(" ")}`);
    const r = await runCommand(python, ["-m", "coverage", "run", "-m", "pytest", ...pytestArgs], root, covEnv, options.log);
    exitCode = r.code;
    tail = r.tail;
    const raw = path.join(dir, "coverage-raw.json");
    const j = await runCommand(python, ["-m", "coverage", "json", "-o", raw, "--show-contexts", "-q"], root, covEnv, options.log, 120_000);
    if (j.code !== 0) coverageSkipped = `coverage json 失败：${j.tail.slice(-300)}`;
    else {
      // 带上下文的原始文件动辄几十 MB，压成只含摘要和「跑过它的测试」的小文件，原始文件删掉。
      const tmp = coverageJson + ".tmp";
      fs.writeFileSync(tmp, compactCoverage(fs.readFileSync(raw, "utf8")), "utf8");
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
  return { python, junit, ...(hasCoverage && !coverageSkipped ? { coverage: coverageJson } : {}), exitCode, elapsedMs: Date.now() - started, tail, ...(coverageSkipped ? { coverageSkipped } : {}) };
}
