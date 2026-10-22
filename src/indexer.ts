import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readOverlay, type Overlay } from "./config.ts";
import { listCandidates, isExcluded, globToRegExp, LANGUAGES, MAX_PARSE_BYTES } from "./files.ts";
import { grammarFor, type GrammarName } from "./parser.ts";
import { extractRawImports, resolveImports, buildFileEdges, detectPythonRoots, pythonTopLevelNames, readTsPaths, type RawImport } from "./imports.ts";
import { buildRules, checkRules } from "./rules.ts";
import { extractFileSymbols } from "./symbols.ts";
import { extractCallSites, resolveCalls, type CallSite, type CallExtraction } from "./calls.ts";
import { PyrightSession, preciseForFile } from "./pyright.ts";
import type { FileRecord, ImportRecord, FileEdge, LayerRules, Violation, AllowedEdge, SymbolRecord, CallEdge } from "./types.ts";

export interface IndexOptions {
  overlayFile?: string;
  /** 是否用 pyright 做精确层；缺省：装了就用。 */
  precise?: boolean;
}

export interface PreciseStats {
  used: boolean;
  skipped: string | null;
  attempted: number;
  upgraded: number;
  externalDefinitions: number;
  elapsedMs: number;
}

export interface IndexResult {
  root: string;
  viaGit: boolean;
  overlay: Overlay;
  files: FileRecord[];
  imports: ImportRecord[];
  edges: FileEdge[];
  pythonRoots: string[];
  rules: LayerRules;
  ruleProblems: string[];
  violations: Violation[];
  allowed: AllowedEdge[];
  layeredEdges: number;
  symbols: SymbolRecord[];
  calls: CallExtraction;
  precise: PreciseStats;
  /** 这一轮重新解析的文件（新增、修改、删除）。 */
  changedFiles: string[];
  elapsedMs: number;
}

interface CachedFile {
  record: FileRecord;
  mtimeMs: number;
  content?: string;
  grammar: GrammarName | null;
  raw: RawImport[];
  symbols: SymbolRecord[];
  sites: CallSite[];
  precise?: { edges: CallEdge[]; resolvedKeys: Set<string>; external: number; attempted: number };
}

/** 增量索引器：每个文件的解析结果按内容缓存，跨文件的解析每轮重算（纯计算，很快）。 */
export class Indexer {
  readonly cache = new Map<string, CachedFile>();
  readonly root: string;
  readonly options: IndexOptions;
  private session: PyrightSession | null = null;
  private ran = false;
  /** 等待重新做精确层的导入方（上一轮为了快先跳过了）。 */
  private deferred = new Set<string>();

  constructor(root: string, options: IndexOptions = {}) {
    this.root = root;
    this.options = options;
  }

  hasDeferred(): boolean {
    return this.deferred.size > 0;
  }

  /**
   * 跑一轮。deferImporters 为 true 时，被改文件的导入方不在本轮做精确层，留到下一轮（先快后准）。
   */
  async run(runOptions: { deferImporters?: boolean } = {}): Promise<IndexResult> {
    const started = Date.now();
    const overlay = readOverlay(this.root, this.options.overlayFile);
    const extra = overlay.exclude.map(globToRegExp);
    const { files: candidates, viaGit } = await listCandidates(this.root);
    const base = await fs.realpath(this.root);
    const seen = new Set<string>();
    const changed: string[] = [];
    for (const rel of [...new Set(candidates)].sort()) {
      if (path.isAbsolute(rel) || rel.split("/").includes("..") || isExcluded(rel, extra)) continue;
      const full = path.join(base, rel);
      let stat;
      try {
        stat = await fs.lstat(full);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      seen.add(rel);
      const cached = this.cache.get(rel);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.record.size === stat.size) continue;
      const buffer = await fs.readFile(full);
      const hash = createHash("sha256").update(buffer).digest("hex");
      if (cached && cached.record.hash === hash) {
        cached.mtimeMs = stat.mtimeMs;
        continue;
      }
      const binary = buffer.subarray(0, 8000).includes(0);
      const ext = path.extname(rel).toLowerCase();
      const language = binary ? "binary" : (LANGUAGES[ext] ?? "other");
      const record: FileRecord = { path: rel, dir: path.posix.dirname(rel), size: buffer.length, hash, language, binary };
      const content = !binary && buffer.length <= MAX_PARSE_BYTES ? buffer.toString("utf8") : undefined;
      const grammar = content !== undefined ? grammarFor(language) : null;
      const entry: CachedFile = { record, mtimeMs: stat.mtimeMs, grammar, raw: [], symbols: [], sites: [], ...(content !== undefined ? { content } : {}) };
      if (grammar && content !== undefined) {
        try {
          entry.raw = await extractRawImports(rel, content, grammar);
          entry.symbols = await extractFileSymbols(rel, content, grammar);
          entry.sites = await extractCallSites(rel, content, grammar);
        } catch {
          entry.raw = [];
        }
      }
      this.cache.set(rel, entry);
      changed.push(rel);
    }
    for (const rel of [...this.cache.keys()]) {
      if (!seen.has(rel)) {
        this.cache.delete(rel);
        changed.push(rel);
        if (this.session) await this.session.forget(rel);
      }
    }

    const entries = [...this.cache.values()].sort((a, b) => a.record.path.localeCompare(b.record.path));
    const files = entries.map((e) => e.record);
    const contents = new Map<string, string>();
    for (const e of entries) if (e.content !== undefined) contents.set(e.record.path, e.content);
    const pythonRoots = detectPythonRoots(files, overlay.source_roots);
    const ctx = { known: new Set(files.map((f) => f.path)), pythonRoots, pythonTopLevel: pythonTopLevelNames(files, pythonRoots), tsPaths: readTsPaths(contents) };
    const imports: ImportRecord[] = [];
    for (const e of entries) imports.push(...resolveImports(e.record.path, e.raw, ctx));
    const edges = buildFileEdges(imports);
    const { rules, problems: ruleProblems } = await buildRules({ overlay, contents });
    const check = checkRules(edges, files, contents, rules);
    const symbols = entries.flatMap((e) => e.symbols);
    const sitesByFile = new Map<string, CallSite[]>();
    for (const e of entries) if (e.sites.length) sitesByFile.set(e.record.path, e.sites);
    const calls = resolveCalls(sitesByFile, symbols, imports);

    const wantPrecise = this.options.precise ?? PyrightSession.available();
    let precise: PreciseStats = { used: false, skipped: wantPrecise ? null : "未启用", attempted: 0, upgraded: 0, externalDefinitions: 0, elapsedMs: 0 };
    if (wantPrecise && PyrightSession.available()) {
      const t0 = Date.now();
      this.session ??= new PyrightSession(this.root);
      const symbolsByFile = new Map<string, SymbolRecord[]>();
      for (const s of symbols) symbolsByFile.set(s.path, [...(symbolsByFile.get(s.path) ?? []), s]);
      const changedSet = new Set(changed);
      const importers = new Set<string>();
      for (const e of edges) if (changedSet.has(e.to) && !changedSet.has(e.from)) importers.add(e.from);
      if (runOptions.deferImporters) {
        for (const f of importers) this.deferred.add(f);
        importers.clear();
      } else {
        for (const f of this.deferred) importers.add(f);
        this.deferred.clear();
      }
      const upgradable = new Set(calls.unresolved.filter((u) => (u.kind === "needs-types" || u.kind === "unknown-name" || u.kind === "inherited") && u.path.endsWith(".py")).map((u) => u.path));
      let attempted = 0;
      for (const e of entries) {
        const file = e.record.path;
        if (!upgradable.has(file) || e.content === undefined) {
          delete e.precise;
          continue;
        }
        const needs = !this.ran || changedSet.has(file) || importers.has(file) || !e.precise;
        if (!needs) continue;
        try {
          const r = await preciseForFile(this.session, file, e.content, calls.unresolved, symbolsByFile);
          e.precise = { edges: r.edges, resolvedKeys: r.resolvedKeys, external: r.externalDefinitions, attempted: r.attempted };
          attempted += r.attempted;
        } catch (error) {
          precise.skipped = error instanceof Error ? error.message : String(error);
        }
      }
      const symbolIds = new Set(symbols.map((s) => s.id));
      let upgraded = 0;
      let external = 0;
      for (const e of entries) {
        if (!e.precise) continue;
        const live = e.precise.edges.filter((edge) => symbolIds.has(edge.to));
        calls.edges.push(...live);
        upgraded += live.length;
        external += e.precise.external;
      }
      calls.unresolved = calls.unresolved.filter((u) => !this.cache.get(u.path)?.precise?.resolvedKeys.has(`${u.line}:${u.col}`));
      precise = { used: precise.skipped === null || attempted > 0, skipped: precise.skipped, attempted, upgraded, externalDefinitions: external, elapsedMs: Date.now() - t0 };
    } else if (wantPrecise) {
      precise.skipped = "未安装 pyright（npm install pyright）";
    }
    this.ran = true;
    return {
      root: this.root, viaGit, overlay, files, imports, edges, pythonRoots, rules, ruleProblems,
      violations: check.violations, allowed: check.allowed, layeredEdges: check.layeredEdges,
      symbols, calls, precise, changedFiles: changed, elapsedMs: Date.now() - started,
    };
  }

  async close(): Promise<void> {
    const s = this.session;
    this.session = null;
    if (s) await s.close();
  }
}
