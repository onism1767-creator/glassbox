import { DatabaseSync } from "node:sqlite";
import type { Snapshot } from "./snapshot.ts";

const SCHEMA = `
create table if not exists meta (key text primary key, value text not null);
create table if not exists files (path text primary key, dir text not null, size integer not null, hash text not null, language text not null, binary integer not null);
create table if not exists imports (src text not null, spec text not null, line integer not null, level integer not null, status text not null, resolved text, reason text);
create table if not exists edges (src text not null, dst text not null, kind text not null, primary key (src, dst, kind));
create table if not exists edge_evidence (src text not null, dst text not null, path text not null, line integer, note text);
create table if not exists rule_provenance (what text not null, tier text not null, path text, line integer, note text);
create table if not exists violations (rule text not null, src text not null, dst text, path text not null, line integer, note text, message text not null);
create table if not exists allowed_edges (src text not null, dst text not null, path text not null, line integer, allowed_by_path text, allowed_by_line integer);
create table if not exists commits (sha text primary key, date text not null, author text not null, subject text not null, stage text);
create table if not exists commit_files (sha text not null, path text not null, added integer not null, deleted integer not null);
create table if not exists baseline (id integer primary key check (id = 1), commit_sha text not null, branch text, set_at text not null, reason text not null);
create table if not exists changes (path text primary key, status text not null, committed integer not null);
create table if not exists symbols (id text primary key, path text not null, kind text not null, name text not null, qualified text not null, parent text, start_line integer not null, end_line integer not null, exported integer, is_default integer);
create table if not exists call_edges (src text not null, dst text not null, path text not null, line integer not null, note text, resolution text not null);
create table if not exists unresolved_calls (path text not null, line integer not null, col integer not null, callee text not null, src text not null, kind text not null, reason text not null);
create index if not exists idx_imports_src on imports (src);
create index if not exists idx_edges_dst on edges (dst);
create index if not exists idx_commit_files_path on commit_files (path);
create index if not exists idx_symbols_path on symbols (path);
create index if not exists idx_call_edges_src on call_edges (src);
create index if not exists idx_call_edges_dst on call_edges (dst);
`;

const TABLES = ["meta", "files", "imports", "edges", "edge_evidence", "rule_provenance", "violations", "allowed_edges", "commits", "commit_files", "baseline", "changes", "symbols", "call_edges", "unresolved_calls"];

/** 把一次快照整体写进 sqlite：先清空再写，简单且可重复。 */
export function writeFacts(dbPath: string, snapshot: Snapshot): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("pragma journal_mode = wal");
    db.exec(SCHEMA);
    db.exec("begin");
    for (const t of TABLES) db.exec(`delete from ${t}`);
    const meta = db.prepare("insert into meta (key, value) values (?, ?)");
    meta.run("schemaVersion", String(snapshot.schemaVersion));
    meta.run("generatedAt", snapshot.generatedAt);
    meta.run("root", snapshot.root);
    meta.run("commit", snapshot.source.commit ?? "");
    meta.run("branch", snapshot.source.branch ?? "");
    meta.run("dirty", snapshot.source.dirty ? "1" : "0");

    const file = db.prepare("insert into files values (?, ?, ?, ?, ?, ?)");
    for (const f of snapshot.files) file.run(f.path, f.dir, f.size, f.hash, f.language, f.binary ? 1 : 0);

    const imp = db.prepare("insert into imports values (?, ?, ?, ?, ?, ?, ?)");
    for (const r of snapshot.imports) imp.run(r.from, r.spec, r.line, r.level, r.status, r.resolved ?? null, r.reason ?? null);

    const edge = db.prepare("insert into edges values (?, ?, ?)");
    const evidence = db.prepare("insert into edge_evidence values (?, ?, ?, ?, ?)");
    for (const e of snapshot.edges) {
      edge.run(e.from, e.to, e.kind);
      for (const ev of e.evidence) evidence.run(e.from, e.to, ev.path, ev.line ?? null, ev.note ?? null);
    }

    const prov = db.prepare("insert into rule_provenance values (?, ?, ?, ?, ?)");
    for (const p of snapshot.rules.provenance) prov.run(p.what, p.tier, p.evidence?.path ?? null, p.evidence?.line ?? null, p.evidence?.note ?? null);

    const violation = db.prepare("insert into violations values (?, ?, ?, ?, ?, ?, ?)");
    for (const v of snapshot.violations) violation.run(v.rule, v.from, v.to ?? null, v.evidence.path, v.evidence.line ?? null, v.evidence.note ?? null, v.message);

    const allowed = db.prepare("insert into allowed_edges values (?, ?, ?, ?, ?, ?)");
    for (const a of snapshot.allowed) allowed.run(a.from, a.to, a.evidence.path, a.evidence.line ?? null, a.allowedBy?.path ?? null, a.allowedBy?.line ?? null);

    const commit = db.prepare("insert into commits values (?, ?, ?, ?, ?)");
    const commitFile = db.prepare("insert into commit_files values (?, ?, ?, ?)");
    for (const c of snapshot.history.commits) {
      commit.run(c.sha, c.date, c.author, c.subject, c.stage ?? null);
      for (const f of c.files) commitFile.run(c.sha, f.path, f.added, f.deleted);
    }

    const symbol = db.prepare("insert into symbols values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const s of snapshot.symbols) symbol.run(s.id, s.path, s.kind, s.name, s.qualified, s.parent ?? null, s.startLine, s.endLine, s.exported ? 1 : null, s.isDefault ? 1 : null);
    const callEdge = db.prepare("insert into call_edges values (?, ?, ?, ?, ?, ?)");
    for (const e of snapshot.calls.edges) callEdge.run(e.from, e.to, e.evidence.path, e.evidence.line ?? 0, e.evidence.note ?? null, e.resolution);
    const unresolvedCall = db.prepare("insert into unresolved_calls values (?, ?, ?, ?, ?, ?, ?)");
    for (const u of snapshot.calls.unresolved) unresolvedCall.run(u.path, u.line, u.col, u.callee, u.from, u.kind, u.reason);

    if (snapshot.baseline) {
      const b = snapshot.baseline.baseline;
      db.prepare("insert into baseline values (1, ?, ?, ?, ?)").run(b.commit, b.branch, b.setAt, b.reason);
      const change = db.prepare("insert into changes values (?, ?, ?)");
      for (const c of snapshot.baseline.changes) change.run(c.path, c.status, c.committed ? 1 : 0);
    }
    db.exec("commit");
  } catch (error) {
    try {
      db.exec("rollback");
    } catch {
      /* 事务可能尚未开始 */
    }
    throw error;
  } finally {
    db.close();
  }
}

/** 读回几个计数，供自检与测试。 */
export function readCounts(dbPath: string): Record<string, number> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const counts: Record<string, number> = {};
    for (const t of TABLES) {
      const row = db.prepare(`select count(*) as n from ${t}`).get() as { n: number } | undefined;
      counts[t] = row?.n ?? 0;
    }
    return counts;
  } finally {
    db.close();
  }
}
