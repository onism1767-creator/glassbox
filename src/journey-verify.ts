/** 旅程的动态检验：带覆盖率跑它指定的测试，记下真实碰到的文件和每步的哈希。 */
import fs from "node:fs";
import path from "node:path";
import { runCommand, probeModule, buildCoverageConfig, defaultCoverageConfig, DEFAULT_COVERAGE_BASE } from "./runtests.ts";
import { parseJunit, parseCoverage } from "./tests.ts";
import { nodeTable, type NodeWorld } from "./annotations.ts";
import { guessPythonPath } from "./pyright.ts";
import type { Journey, Verification } from "./journeys.ts";

export interface VerifyOptions {
  stateDir: string;
  python?: string;
  log?: (line: string) => void;
  timeoutMs?: number;
}

export async function verifyJourney(root: string, world: NodeWorld, journey: Journey, options: VerifyOptions): Promise<Verification> {
  if (!journey.verify?.tests.length) throw new Error(`旅程 ${journey.id} 没指定验证用的测试（verify.tests）`);
  const started = Date.now();
  const python = options.python ?? guessPythonPath(root) ?? "python";
  const probe = await probeModule(python, "pytest", root);
  if (probe === "no-interpreter") throw new Error(`找不到 Python 解释器：${python}`);
  if (probe === "missing") throw new Error(`${python} 里没有 pytest`);
  if ((await probeModule(python, "coverage", root)) !== "ok") throw new Error(`${python} 里没有 coverage，动态检验要靠它知道测试碰到了哪些文件`);
  const dir = path.join(options.stateDir, "test-results", "journeys", journey.id);
  fs.mkdirSync(dir, { recursive: true });
  let plan = buildCoverageConfig(root);
  let rc = path.join(dir, plan.file);
  fs.writeFileSync(rc, plan.text, "utf8");
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", COVERAGE_FILE: path.join(dir, ".coverage"), COVERAGE_RCFILE: rc };
  if (plan.base !== DEFAULT_COVERAGE_BASE) {
    const check = await runCommand(python, ["-m", "coverage", "debug", "config"], root, env, undefined, 60_000);
    if (check.code !== 0) {
      plan = defaultCoverageConfig();
      rc = path.join(dir, plan.file);
      fs.writeFileSync(rc, plan.text, "utf8");
      env.COVERAGE_RCFILE = rc;
    }
  }
  const junit = path.join(dir, "junit.xml");
  const covJson = path.join(dir, "coverage.json");
  fs.rmSync(junit, { force: true });
  fs.rmSync(covJson, { force: true });
  fs.rmSync(path.join(dir, ".coverage"), { force: true });
  const args = ["-m", "coverage", "run", "-m", "pytest", "-p", "no:cacheprovider", "-q", `--junitxml=${junit}`, ...journey.verify.tests];
  options.log?.(`验证旅程 ${journey.id}：${python} ${args.join(" ")}`);
  const r = await runCommand(python, args, root, env, options.log, options.timeoutMs ?? 600_000);
  const j = await runCommand(python, ["-m", "coverage", "json", "-o", covJson, "-q"], root, env, options.log, 120_000);
  if (j.code !== 0 || !fs.existsSync(covJson)) throw new Error(`coverage json 失败：${j.tail.slice(-300)}`);
  const known = new Set(world.files.map((f) => f.path));
  const run = fs.existsSync(junit) ? parseJunit(fs.readFileSync(junit, "utf8"), known, "journeys/junit.xml", new Date().toISOString()) : undefined;
  const cov = parseCoverage(fs.readFileSync(covJson, "utf8"), root, "journeys/coverage.json", new Date().toISOString());
  const touched = Object.entries(cov.files).filter(([, f]) => f.covered > 0).map(([p]) => p).sort();
  const table = nodeTable(world);
  const stepHashes: Record<string, string> = {};
  for (const s of journey.steps) {
    const info = table.get(s.node);
    if (info) stepHashes[s.node] = info.hash;
  }
  return {
    id: journey.id,
    at: new Date().toISOString(),
    tests: journey.verify.tests,
    touched,
    passed: run?.passed ?? 0,
    failed: (run?.failed ?? 0) + (run?.errors ?? 0),
    skipped: run?.skipped ?? 0,
    exitCode: r.code,
    elapsedMs: Date.now() - started,
    stepHashes,
    python,
  };
}
