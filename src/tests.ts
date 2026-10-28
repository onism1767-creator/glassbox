/**
 * 测试结果（T0）：pytest 的 junit xml 给每个测试通过与否；coverage 的 json 给每个源文件的覆盖率，
 * 开了 dynamic context 还能知道每个测试跑过哪些文件。
 */
import fs from "node:fs";
import path from "node:path";
import type { FileEdge, Tier } from "./types.ts";

export type TestStatus = "passed" | "failed" | "error" | "skipped";

export interface TestCase {
  id: string;
  name: string;
  classname: string;
  file?: string;
  status: TestStatus;
  durationMs: number;
  message?: string;
}

/** 最近一次「只跑相关测试」的情况（结果已合并进 cases）。 */
export interface PartialRun {
  at: string;
  changed: string[];
  ran: number;
  passed: number;
  failed: number;
  skipped: number;
  elapsedMs: number;
  granularity: "case" | "file";
  items: { path: string; how: string; tier?: Tier }[];
  skippedFiles: { path: string; why: string }[];
}

export interface TestRun {
  source: string;
  at: string;
  /** 上一次全量跑的时间（有过部分合并时才有）。 */
  fullAt?: string;
  partial?: PartialRun;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  cases: TestCase[];
}

/** 自动跑相关测试的开关状态，给画布看。 */
export interface AutoTestState {
  enabled: boolean;
  python?: string;
  why?: string;
  running?: { since: string; changed: string[]; estimated: number; args: number };
}

export interface CoverageFile {
  percent: number;
  covered: number;
  total: number;
}

export interface CoverageData {
  source: string;
  at: string;
  hasContexts: boolean;
  /** 覆盖率按哪份配置算的（glassbox test 写进 meta；项目自己的配置或 glassbox 缺省）。 */
  config?: string;
  totalPercent: number;
  files: Record<string, CoverageFile>;
  /** 源文件 → 跑过它的测试 id（只有 hasContexts 时有）。 */
  coveredBy: Record<string, string[]>;
}

export interface FileTestStatus {
  /** 相关测试 id。 */
  related: string[];
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  /** related 是怎么来的：coverage 上下文（T0）还是 import 图推断（T1）。 */
  tier: Tier;
  /** 等级不是 T0 时的原因说明（比如上下文对上了不止一个同名测试模块）。 */
  note?: string;
  coverage?: CoverageFile;
}

export interface TestSnapshot {
  run?: TestRun;
  auto?: AutoTestState;
  coverage?: Omit<CoverageData, "coveredBy">;
  fileStatus: Record<string, FileTestStatus>;
  /** 含测试用例的文件。 */
  testFiles: string[];
  problems: string[];
  howTo: string;
}

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" };
function unescape(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos);|&#(\d+);|&#x([0-9a-fA-F]+);/g, (m, named: string | undefined, dec: string | undefined, hex: string | undefined) => {
    if (named) return ENTITIES[`&${named};`] ?? m;
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return m;
  });
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1] ?? ""] = unescape(m[2] ?? "");
  return out;
}

function normalizePath(p: string, root?: string): string {
  let s = p.split("\\").join("/");
  if (root) {
    const r = root.split("\\").join("/").replace(/\/+$/, "");
    if (s.toLowerCase().startsWith(r.toLowerCase() + "/")) s = s.slice(r.length + 1);
  }
  return s.replace(/^\.\//, "");
}

/** pytest 的 classname 像 tests.unit.test_x 或 tests.unit.test_x.TestFoo，逐段试到找到真实文件。 */
export function classnameToFile(classname: string, known: Set<string>): { file?: string; rest: string[] } {
  const parts = classname.split(".").filter(Boolean);
  for (let k = parts.length; k >= 1; k--) {
    const candidate = parts.slice(0, k).join("/") + ".py";
    if (known.has(candidate)) return { file: candidate, rest: parts.slice(k) };
    const init = parts.slice(0, k).join("/") + "/__init__.py";
    if (known.has(init)) return { file: init, rest: parts.slice(k) };
  }
  return { rest: parts };
}

export function parseJunit(xml: string, known: Set<string>, source: string, fallbackAt: string): TestRun {
  const suiteTag = /<testsuite\b[^>]*>/.exec(xml)?.[0] ?? "";
  const suite = attrs(suiteTag);
  const cases: TestCase[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const a = attrs(m[1] ?? "");
    const body = m[3] ?? "";
    let status: TestStatus = "passed";
    let message: string | undefined;
    const inner = /<(failure|error|skipped)\b([^>]*)>?/.exec(body);
    if (inner) {
      status = inner[1] === "failure" ? "failed" : inner[1] === "error" ? "error" : "skipped";
      const msg = attrs(inner[2] ?? "")["message"];
      if (msg) message = msg.slice(0, 300);
    }
    const classname = a["classname"] ?? "";
    const name = a["name"] ?? "";
    const explicit = a["file"] ? normalizePath(a["file"]) : undefined;
    const mapped = explicit && known.has(explicit) ? { file: explicit, rest: [] as string[] } : classnameToFile(classname, known);
    const id = mapped.file ? `${mapped.file}::${[...mapped.rest, name].join("::")}` : `${classname}::${name}`;
    cases.push({ id, name, classname, ...(mapped.file ? { file: mapped.file } : {}), status, durationMs: Math.round(Number(a["time"] ?? "0") * 1000), ...(message ? { message } : {}) });
  }
  const count = (s: TestStatus) => cases.filter((c) => c.status === s).length;
  return {
    source,
    at: suite["timestamp"] ?? fallbackAt,
    total: cases.length,
    passed: count("passed"),
    failed: count("failed"),
    errors: count("error"),
    skipped: count("skipped"),
    cases,
  };
}

interface CoverageJson {
  meta?: { timestamp?: string; show_contexts?: boolean; config?: string };
  files?: Record<string, { summary?: { covered_lines?: number; num_statements?: number; percent_covered?: number }; contexts?: Record<string, string[]>; tests?: string[] }>;
  totals?: { percent_covered?: number };
  /** glassbox 自己压过的格式：每个文件只留摘要和「跑过它的测试」集合。 */
  compact?: true;
}

export function parseCoverage(text: string, root: string, source: string, fallbackAt: string): CoverageData {
  const json = JSON.parse(text) as CoverageJson;
  const files: Record<string, CoverageFile> = {};
  const coveredBy: Record<string, string[]> = {};
  for (const [rawPath, info] of Object.entries(json.files ?? {})) {
    const p = normalizePath(rawPath, root);
    const s = info.summary ?? {};
    files[p] = { percent: Math.round((s.percent_covered ?? 0) * 10) / 10, covered: s.covered_lines ?? 0, total: s.num_statements ?? 0 };
    const ids = new Set<string>();
    for (const id of info.tests ?? []) if (id) ids.add(normalizePath(id, root));
    if (info.contexts) {
      for (const list of Object.values(info.contexts)) for (const ctx of list) {
        const id = ctx.split("|")[0]?.trim() ?? "";
        if (id) ids.add(normalizePath(id, root));
      }
    }
    if (ids.size) coveredBy[p] = [...ids].sort();
  }
  return {
    source,
    at: json.meta?.timestamp ?? fallbackAt,
    hasContexts: Boolean(json.meta?.show_contexts) || Object.keys(coveredBy).length > 0,
    ...(json.meta?.config ? { config: json.meta.config } : {}),
    totalPercent: Math.round((json.totals?.percent_covered ?? 0) * 10) / 10,
    files,
    coveredBy,
  };
}

/** 把 coverage json（带上下文时动辄几十 MB）压成只含摘要和「跑过它的测试」集合的小文件。 */
export function compactCoverage(text: string, extra: { config?: string } = {}): string {
  const json = JSON.parse(text) as CoverageJson;
  const files: Record<string, { summary: { covered_lines: number; num_statements: number; percent_covered: number }; tests: string[] }> = {};
  for (const [p, info] of Object.entries(json.files ?? {})) {
    const s = info.summary ?? {};
    const ids = new Set<string>();
    for (const list of Object.values(info.contexts ?? {})) for (const ctx of list) {
      const id = ctx.split("|")[0]?.trim() ?? "";
      if (id) ids.add(id);
    }
    for (const id of info.tests ?? []) if (id) ids.add(id);
    files[p] = { summary: { covered_lines: s.covered_lines ?? 0, num_statements: s.num_statements ?? 0, percent_covered: s.percent_covered ?? 0 }, tests: [...ids].sort() };
  }
  const config = extra.config ?? json.meta?.config;
  return JSON.stringify({ compact: true, meta: { timestamp: json.meta?.timestamp, show_contexts: Boolean(json.meta?.show_contexts), ...(config ? { config } : {}) }, totals: { percent_covered: json.totals?.percent_covered ?? 0 }, files });
}

/**
 * 覆盖率上下文里的测试名对回 junit 用例 id。两种写法都见过：
 * - coverage 自己的 dynamic_context = test_function 记「模块名.函数名」，像 test_resolve.test_follows_chain，
 *   没有目录、没有参数化的 [..]，所以一个上下文可能对应多个参数化用例；
 * - pytest-cov 的 --cov-context=test 记 pytest 的 node id，像 tests/unit/test_resolve.py::test_x[a]|run。
 */
export interface ContextResolver {
  (ctx: string): string[];
  /** 对上了不止一个同名测试模块的上下文（去掉 |run 后缀）；这些的归属不确定，几个都算了进去。 */
  ambiguous: Set<string>;
}

export function contextResolver(cases: TestCase[], testFiles: string[]): ContextResolver {
  const byBase = new Map<string, string[]>();
  for (const c of cases) {
    const base = c.id.replace(/\[.*\]$/, "");
    byBase.set(base, [...(byBase.get(base) ?? []), c.id]);
  }
  const moduleOf = (f: string) => f.replace(/\.py$/, "").replace(/\/__init__$/, "").split("/").join(".");
  const modules = testFiles.map((f) => ({ f, m: moduleOf(f) }));
  const memo = new Map<string, string[]>();
  const ambiguous = new Set<string>();
  const resolve = ((raw: string) => {
    const ctx = raw.split("|")[0]?.trim() ?? "";
    if (!ctx) return [];
    const hit = memo.get(ctx);
    if (hit) return hit;
    let out: string[] = [];
    if (ctx.includes("::")) {
      out = byBase.get(normalizePath(ctx).replace(/\[.*\]$/, "")) ?? [];
    } else {
      const parts = ctx.split(".");
      for (let k = parts.length - 1; k >= 1 && !out.length; k--) {
        const mod = parts.slice(0, k).join(".");
        const rest = parts.slice(k).join("::");
        // 模块名完全相等的优先；只有后缀相同（tests.unit.test_a 对 test_a）的才会出现歧义。
        const exact = modules.filter(({ m }) => m === mod);
        const pool = exact.length ? exact : modules.filter(({ m }) => m.endsWith("." + mod));
        const hits = pool.map(({ f }) => byBase.get(`${f}::${rest}`)).filter((ids): ids is string[] => !!ids);
        if (hits.length) {
          out = [...new Set(hits.flat())].sort();
          if (hits.length > 1) ambiguous.add(ctx);
        }
      }
    }
    memo.set(ctx, out);
    return out;
  }) as ContextResolver;
  resolve.ambiguous = ambiguous;
  return resolve;
}

/** 把测试结果挂到源文件上：有覆盖率上下文用上下文（T0），否则按「测试文件 import 了谁」推断（T1）。 */
export function linkTests(run: TestRun | undefined, coverage: CoverageData | undefined, edges: FileEdge[], files: string[]): { fileStatus: Record<string, FileTestStatus>; testFiles: string[] } {
  const fileStatus: Record<string, FileTestStatus> = {};
  if (!run) return { fileStatus, testFiles: [] };
  const byId = new Map(run.cases.map((c) => [c.id, c]));
  const testFiles = [...new Set(run.cases.map((c) => c.file).filter((f): f is string => !!f))].sort();
  const resolve = contextResolver(run.cases, testFiles);
  const casesByTestFile = new Map<string, TestCase[]>();
  for (const c of run.cases) if (c.file) casesByTestFile.set(c.file, [...(casesByTestFile.get(c.file) ?? []), c]);
  const importers = new Map<string, Set<string>>();
  for (const e of edges) if (casesByTestFile.has(e.from)) importers.set(e.to, new Set([...(importers.get(e.to) ?? []), e.from]));
  const tally = (ids: string[], tier: Tier, p?: CoverageFile): FileTestStatus => {
    const st: FileTestStatus = { related: ids, passed: 0, failed: 0, errors: 0, skipped: 0, tier, ...(p ? { coverage: p } : {}) };
    for (const id of ids) {
      const c = byId.get(id);
      if (!c) continue;
      if (c.status === "passed") st.passed++;
      else if (c.status === "failed") st.failed++;
      else if (c.status === "error") st.errors++;
      else st.skipped++;
    }
    return st;
  };
  for (const f of files) {
    const cov = coverage?.files[f];
    if (casesByTestFile.has(f)) {
      fileStatus[f] = tally((casesByTestFile.get(f) ?? []).map((c) => c.id), "T0", cov);
      continue;
    }
    const viaContext = coverage?.coveredBy[f];
    if (viaContext && viaContext.length) {
      const ids = [...new Set(viaContext.flatMap(resolve))].sort();
      if (ids.length) {
        // 上下文对上了不止一个同名测试模块：几个都算进来，但归属不确定，等级降为推导。
        const unsure = viaContext.map((c) => c.split("|")[0]?.trim() ?? "").filter((c) => resolve.ambiguous.has(c));
        const st = tally(ids, unsure.length ? "T1" : "T0", cov);
        if (unsure.length) st.note = `覆盖率上下文 ${unsure.slice(0, 2).join("、")}${unsure.length > 2 ? " 等" : ""} 对上了不止一个同名测试模块，几个都算了进来`;
        fileStatus[f] = st;
        continue;
      }
    }
    const testers = importers.get(f);
    if (testers && testers.size) {
      const ids = [...testers].flatMap((tf) => (casesByTestFile.get(tf) ?? []).map((c) => c.id));
      fileStatus[f] = tally(ids, "T1", cov);
      continue;
    }
    if (cov) fileStatus[f] = tally([], "T0", cov);
  }
  return { fileStatus, testFiles };
}

export interface TestSources {
  junit?: string;
  coverage?: string;
}

/** 在状态目录和 overlay 指定的位置找结果文件。 */
export function locateTestResults(root: string, stateDir: string, configured: TestSources = {}): { junit?: string; coverage?: string } {
  const candidates = {
    junit: [configured.junit ? path.resolve(root, configured.junit) : "", path.join(stateDir, "test-results", "junit.xml"), path.join(root, "junit.xml"), path.join(root, "reports", "junit.xml")],
    coverage: [configured.coverage ? path.resolve(root, configured.coverage) : "", path.join(stateDir, "test-results", "coverage.json"), path.join(root, "coverage.json")],
  };
  const pick = (list: string[]) => list.find((p) => p && fs.existsSync(p));
  const junit = pick(candidates.junit);
  const coverage = pick(candidates.coverage);
  return { ...(junit ? { junit } : {}), ...(coverage ? { coverage } : {}) };
}

const cache = new Map<string, { mtimeMs: number; value: unknown }>();
/** 按 mtime 缓存解析结果。文件读不了 → undefined；解析本身抛错 → 原样抛出去，让调用方记进 problems。 */
function cached<T>(file: string, load: (text: string, at: string) => T): T | undefined {
  let st: fs.Stats;
  let text: string;
  try {
    st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.value as T;
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const value = load(text, st.mtime.toISOString());
  cache.set(file, { mtimeMs: st.mtimeMs, value });
  return value;
}

function mtimeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

export function readTestResults(root: string, stateDir: string, known: Set<string>, edges: FileEdge[], configured: TestSources = {}): TestSnapshot {
  const where = locateTestResults(root, stateDir, configured);
  const problems: string[] = [];
  const inside = (p: string, dir: string) => {
    const r = path.relative(dir, p);
    return r && !r.startsWith("..") && !path.isAbsolute(r) ? r.split(path.sep).join("/") : undefined;
  };
  // 结果文件通常在状态目录里（可能在仓库外），显示成「状态目录/…」而不是一串 ../../
  const rel = (p: string) => {
    const inState = inside(p, stateDir);
    if (inState) return `状态目录/${inState}`;
    return inside(p, root) ?? p.split("\\").join("/");
  };
  let run: TestRun | undefined;
  let coverage: CoverageData | undefined;
  if (where.junit) {
    run = cached(where.junit, (text, at) => parseJunit(text, known, rel(where.junit!), at));
    if (!run) problems.push(`读不了 ${rel(where.junit)}`);
  }
  // 自动跑相关测试会把合并后的结果写成 results.json；它比 junit.xml 新就用它（全量跑一次又会把它盖过去）。
  const merged = path.join(stateDir, "test-results", "results.json");
  const mergedAt = mtimeOf(merged);
  if (mergedAt !== undefined) {
    const junitAt = where.junit ? mtimeOf(where.junit) : undefined;
    const newer = junitAt === undefined || mergedAt >= junitAt;
    if (newer) {
      try {
        const m = cached(merged, (text) => {
          const parsed = JSON.parse(text) as { version?: number; run?: TestRun };
          return parsed.version === 1 && parsed.run && Array.isArray(parsed.run.cases) ? parsed.run : undefined;
        });
        if (m) run = m;
        else problems.push("results.json 格式不对，忽略了");
      } catch (error) {
        problems.push(`results.json 读不了，忽略了：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (where.coverage) {
    try {
      coverage = cached(where.coverage, (text, at) => parseCoverage(text, root, rel(where.coverage!), at));
      if (!coverage) problems.push(`读不了 ${rel(where.coverage)}`);
    } catch (error) {
      coverage = undefined;
      problems.push(`${rel(where.coverage)} 解析失败，这次没有覆盖率：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const { fileStatus, testFiles } = linkTests(run, coverage, edges, [...known]);
  const howTo = "跑一次 glassbox test <仓库>，或自己跑 pytest --junitxml=.workbench/test-results/junit.xml（加 coverage json --show-contexts 更好）";
  return {
    ...(run ? { run } : {}),
    ...(coverage ? { coverage: { source: coverage.source, at: coverage.at, hasContexts: coverage.hasContexts, ...(coverage.config ? { config: coverage.config } : {}), totalPercent: coverage.totalPercent, files: coverage.files } } : {}),
    fileStatus,
    testFiles,
    problems,
    howTo,
  };
}
