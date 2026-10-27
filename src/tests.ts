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

export interface TestRun {
  source: string;
  at: string;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  cases: TestCase[];
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
  coverage?: CoverageFile;
}

export interface TestSnapshot {
  run?: TestRun;
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
  meta?: { timestamp?: string; show_contexts?: boolean };
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
    totalPercent: Math.round((json.totals?.percent_covered ?? 0) * 10) / 10,
    files,
    coveredBy,
  };
}

/** 把 coverage json（带上下文时动辄几十 MB）压成只含摘要和「跑过它的测试」集合的小文件。 */
export function compactCoverage(text: string): string {
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
  return JSON.stringify({ compact: true, meta: { timestamp: json.meta?.timestamp, show_contexts: Boolean(json.meta?.show_contexts) }, totals: { percent_covered: json.totals?.percent_covered ?? 0 }, files });
}

/**
 * 覆盖率上下文里的测试名对回 junit 用例 id。两种写法都见过：
 * - coverage 自己的 dynamic_context = test_function 记「模块名.函数名」，像 test_resolve.test_follows_chain，
 *   没有目录、没有参数化的 [..]，所以一个上下文可能对应多个参数化用例；
 * - pytest-cov 的 --cov-context=test 记 pytest 的 node id，像 tests/unit/test_resolve.py::test_x[a]|run。
 */
export function contextResolver(cases: TestCase[], testFiles: string[]): (ctx: string) => string[] {
  const byBase = new Map<string, string[]>();
  for (const c of cases) {
    const base = c.id.replace(/\[.*\]$/, "");
    byBase.set(base, [...(byBase.get(base) ?? []), c.id]);
  }
  const moduleOf = (f: string) => f.replace(/\.py$/, "").replace(/\/__init__$/, "").split("/").join(".");
  const modules = testFiles.map((f) => ({ f, m: moduleOf(f) }));
  const memo = new Map<string, string[]>();
  return (raw) => {
    const ctx = raw.split("|")[0]?.trim() ?? "";
    if (!ctx) return [];
    const hit = memo.get(ctx);
    if (hit) return hit;
    let out: string[] = [];
    if (ctx.includes("::")) {
      out = byBase.get(normalizePath(ctx).replace(/\[.*\]$/, "")) ?? [];
    } else {
      const parts = ctx.split(".");
      outer: for (let k = parts.length - 1; k >= 1; k--) {
        const mod = parts.slice(0, k).join(".");
        const rest = parts.slice(k).join("::");
        for (const { f, m } of modules) {
          if (m !== mod && !m.endsWith("." + mod)) continue;
          const ids = byBase.get(`${f}::${rest}`);
          if (ids) {
            out = ids;
            break outer;
          }
        }
      }
    }
    memo.set(ctx, out);
    return out;
  };
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
        fileStatus[f] = tally(ids, "T0", cov);
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
function cached<T>(file: string, load: (text: string, at: string) => T): T | undefined {
  try {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.value as T;
    const value = load(fs.readFileSync(file, "utf8"), st.mtime.toISOString());
    cache.set(file, { mtimeMs: st.mtimeMs, value });
    return value;
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
  if (where.coverage) {
    try {
      coverage = cached(where.coverage, (text, at) => parseCoverage(text, root, rel(where.coverage!), at));
    } catch (error) {
      problems.push(`coverage.json 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const { fileStatus, testFiles } = linkTests(run, coverage, edges, [...known]);
  const howTo = "跑一次 glassbox test <仓库>，或自己跑 pytest --junitxml=.workbench/test-results/junit.xml（加 coverage json --show-contexts 更好）";
  return {
    ...(run ? { run } : {}),
    ...(coverage ? { coverage: { source: coverage.source, at: coverage.at, hasContexts: coverage.hasContexts, totalPercent: coverage.totalPercent, files: coverage.files } } : {}),
    fileStatus,
    testFiles,
    problems,
    howTo,
  };
}
