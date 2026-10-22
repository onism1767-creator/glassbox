import { useEffect, useState } from "react";
import type { GNode, Level } from "./model.ts";
import { SnapshotIndex, topDir, kindText, changeText, COLORS } from "./model.ts";
import { fetchSource, type SourceExcerpt } from "./api.ts";
import type { Evidence } from "../../src/types.ts";

function Tier({ t }: { t: string }) {
  const label = t === "T0" ? "T0 观测" : t === "T1" ? "T1 推导" : t === "T2" ? "T2 声明" : t === "T3" ? "T3 验证" : t;
  return <span className={`tier ${t}`}>{label}</span>;
}

function EvidenceLine({ ev, onOpen }: { ev: Evidence; onOpen: (ev: Evidence) => void }) {
  return (
    <button className="evidence" onClick={() => onOpen(ev)} title="看源码">
      {ev.path}
      {ev.line ? `:${ev.line}` : ""}
      {ev.note ? <span className="note">{ev.note}</span> : null}
    </button>
  );
}

function Source({ excerpt, target }: { excerpt: SourceExcerpt; target: number }) {
  return (
    <pre className="source">
      {excerpt.lines.map((l, i) => {
        const n = excerpt.from + i;
        return (
          <div key={n} className={n === target ? "hit" : ""}>
            <span className="ln">{n}</span>
            {l}
          </div>
        );
      })}
    </pre>
  );
}

export function Panel({ ix, selected, onNavigate }: { ix: SnapshotIndex; selected: GNode | null; onNavigate: (level: Level, select?: string) => void }) {
  const [open, setOpen] = useState<{ ev: Evidence; excerpt?: SourceExcerpt; error?: string } | null>(null);
  useEffect(() => setOpen(null), [selected]);
  const openEvidence = (ev: Evidence): void => {
    setOpen({ ev });
    fetchSource(ev.path, ev.line ?? 1)
      .then((excerpt) => setOpen({ ev, excerpt }))
      .catch((e: unknown) => setOpen({ ev, error: e instanceof Error ? e.message : String(e) }));
  };
  const s = ix.s;
  if (!selected) {
    return (
      <aside className="panel">
        <h2>快照</h2>
        <dl>
          <dt>来源</dt>
          <dd>
            {s.source.commit?.slice(0, 9) ?? "无 git"} {s.source.branch ?? ""} {s.source.dirty ? "· 工作区有改动" : ""}
          </dd>
          <dt>生成</dt>
          <dd>{s.generatedAt.replace("T", " ").slice(0, 19)}</dd>
          <dt>规模</dt>
          <dd>
            {s.files.length} 文件 · {s.symbols.length} 符号 · {s.edges.length} 条 import 边 · {s.calls.edges.length} 条调用边
          </dd>
          <dt>规则来源</dt>
          <dd>
            {s.rules.provenance.length ? s.rules.provenance.map((p, i) => (
              <div key={i}>
                <Tier t={p.tier} /> {p.what}
                {p.evidence ? <EvidenceLine ev={p.evidence} onOpen={openEvidence} /> : null}
              </div>
            )) : "overlay 未声明分层"}
          </dd>
          <dt>违规</dt>
          <dd>{s.violations.length} 处 <Tier t="T1" /></dd>
          <dt>白名单放行</dt>
          <dd>{s.allowed.length} 处 <Tier t="T1" /></dd>
          {s.history.latestStage ? (
            <>
              <dt>代码到达的阶段</dt>
              <dd>
                {s.history.latestStage} <Tier t="T0" />
              </dd>
            </>
          ) : null}
          {s.baseline ? (
            <>
              <dt>基线</dt>
              <dd>
                {s.baseline.baseline.commit.slice(0, 9)}（{s.baseline.baseline.reason}）之后 {s.baseline.commitsSince} 个提交、{s.baseline.changes.length} 个文件变更 <Tier t="T0" />
              </dd>
            </>
          ) : (
            <>
              <dt>基线</dt>
              <dd>未记录</dd>
            </>
          )}
        </dl>
        <p className="hint">点一个方块看详情，双击下钻。</p>
        {open ? <SourceBlock open={open} /> : null}
      </aside>
    );
  }
  const ref = selected.ref;
  if (ref.kind === "portal") {
    return (
      <aside className="panel">
        <h2>{selected.label}</h2>
        <p>{selected.sub}</p>
        <button className="primary" onClick={() => onNavigate(ref.target)}>
          跳过去
        </button>
      </aside>
    );
  }
  if (ref.kind === "dir") {
    const files = ix.filesByTop.get(ref.dir) ?? [];
    const layer = ix.layers[ref.dir];
    const layerProv = s.rules.provenance.find((p) => p.what === "layers");
    const out = s.dirEdges.filter((e) => e.from === ref.dir);
    const inn = s.dirEdges.filter((e) => e.to === ref.dir);
    const violations = s.violations.filter((v) => topDir(v.evidence.path) === ref.dir);
    const allowed = s.allowed.filter((a) => topDir(a.evidence.path) === ref.dir);
    const changes = (s.baseline?.changes ?? []).filter((c) => topDir(c.path) === ref.dir);
    return (
      <aside className="panel">
        <h2>{selected.label}/</h2>
        <dl>
          <dt>层</dt>
          <dd>
            {layer !== undefined ? (
              <>
                L{layer} <Tier t={layerProv?.tier ?? "T2"} />
                {layerProv?.evidence ? <EvidenceLine ev={layerProv.evidence} onOpen={openEvidence} /> : null}
              </>
            ) : (
              "不在分层内"
            )}
          </dd>
          <dt>文件</dt>
          <dd>
            {files.length} 个 <Tier t="T0" />
          </dd>
          <dt>依赖谁</dt>
          <dd>{out.length ? out.map((e) => <div key={e.to}>→ {e.to}（{e.count}{e.allowed ? `，白名单 ${e.allowed}` : ""}{e.violations ? `，违规 ${e.violations}` : ""}）</div>) : "无"}</dd>
          <dt>谁依赖它</dt>
          <dd>{inn.length ? inn.map((e) => <div key={e.from}>← {e.from}（{e.count}）</div>) : "无"}</dd>
          <dt>违规 <Tier t="T1" /></dt>
          <dd>{violations.length ? violations.map((v, i) => <div key={i} className="red">{v.message}<EvidenceLine ev={v.evidence} onOpen={openEvidence} /></div>) : "无"}</dd>
          <dt>白名单放行 <Tier t="T1" /></dt>
          <dd>{allowed.length ? allowed.map((a, i) => <div key={i}><EvidenceLine ev={a.evidence} onOpen={openEvidence} />{a.allowedBy ? <span className="muted"> 放行依据 <EvidenceLine ev={a.allowedBy} onOpen={openEvidence} /></span> : null}</div>) : "无"}</dd>
          <dt>自基线的改动 <Tier t="T0" /></dt>
          <dd>{changes.length ? changes.slice(0, 30).map((c) => <div key={c.path} style={{ color: COLORS.change[c.status] }}>{changeText(c.status, !c.committed)} {c.path}</div>) : "无"}{changes.length > 30 ? <div className="muted">… 另 {changes.length - 30} 个</div> : null}</dd>
        </dl>
        <button className="primary" onClick={() => onNavigate({ kind: "files", dir: ref.dir })}>
          展开文件
        </button>
        {open ? <SourceBlock open={open} /> : null}
      </aside>
    );
  }
  if (ref.kind === "file") {
    const f = ix.files.get(ref.path);
    const symbols = ix.symbolsByFile.get(ref.path) ?? [];
    const imports = s.imports.filter((r) => r.from === ref.path);
    const outs = ix.fileEdgesFrom.get(ref.path) ?? [];
    const ins = ix.fileEdgesTo.get(ref.path) ?? [];
    const violations = ix.violationsByFile.get(ref.path) ?? [];
    const change = ix.changeOf(ref.path);
    return (
      <aside className="panel">
        <h2>{ref.path}</h2>
        <dl>
          <dt>基本</dt>
          <dd>
            {f?.language} · {f ? `${(f.size / 1024).toFixed(1)} KB` : ""} · {changeText(change.status, change.uncommitted)} <Tier t="T0" />
          </dd>
          <dt>import <Tier t="T0" /></dt>
          <dd>
            {imports.length ? imports.map((r, i) => (
              <div key={i} className={r.status === "unresolved" ? "red" : r.status === "external" ? "muted" : ""}>
                {r.spec} → {r.status === "resolved" ? r.resolved : r.status === "external" ? "外部" : `未解析（${r.reason ?? ""}）`}
              </div>
            )) : "无"}
          </dd>
          <dt>被谁 import</dt>
          <dd>{ins.length ? ins.map((e) => <div key={e.from}>← {e.from}（{e.evidence.length}）</div>) : "无"}</dd>
          <dt>违规 <Tier t="T1" /></dt>
          <dd>{violations.length ? violations.map((v, i) => <div key={i} className="red">{v.message}<EvidenceLine ev={v.evidence} onOpen={openEvidence} /></div>) : "无"}</dd>
          <dt>符号 <Tier t="T0" /></dt>
          <dd>
            {symbols.length ? symbols.map((sym) => (
              <div key={sym.id}>
                <button className="link" onClick={() => onNavigate({ kind: "symbols", file: ref.path }, `sym:${sym.id}`)}>
                  {kindText(sym.kind)} {sym.qualified}
                </button>
                <span className="muted"> {sym.startLine}–{sym.endLine}</span>
              </div>
            )) : "无（非代码文件或没有定义）"}
          </dd>
          <dt>import 出去的边</dt>
          <dd>{outs.length ? outs.map((e) => <div key={e.to}>→ {e.to}{e.evidence.map((ev, i) => <EvidenceLine key={i} ev={ev} onOpen={openEvidence} />)}</div>) : "无"}</dd>
        </dl>
        {symbols.length ? (
          <button className="primary" onClick={() => onNavigate({ kind: "symbols", file: ref.path })}>
            展开符号
          </button>
        ) : null}
        {open ? <SourceBlock open={open} /> : null}
      </aside>
    );
  }
  const sym = ix.symbols.get(ref.id);
  const callers = ix.callsTo.get(ref.id) ?? [];
  const callees = ix.callsFrom.get(ref.id) ?? [];
  const unresolved = ix.unresolvedFrom.get(ref.id) ?? [];
  const resText = (r: string): string => (r === "same-file" ? "同文件" : r === "import" ? "按 import" : r === "self" ? "self 同类" : r === "pyright" ? "pyright 类型推断" : r);
  return (
    <aside className="panel">
      <h2>{sym ? `${kindText(sym.kind)} ${sym.qualified}` : selected.label}</h2>
      {sym ? (
        <p className="muted">
          {sym.path} · {sym.startLine}–{sym.endLine} 行 <Tier t="T0" />
          <button className="link" onClick={() => openEvidence({ path: sym.path, line: sym.startLine })}>看定义</button>
        </p>
      ) : null}
      <dl>
        <dt>调用者 {callers.length} <Tier t="T0" /></dt>
        <dd>
          {callers.length ? callers.map((c, i) => (
            <div key={i}>
              <button className="link" onClick={() => onNavigate({ kind: "symbols", file: c.from.split("::")[0] ?? "" }, `sym:${c.from}`)}>{c.from}</button>
              <span className="res" style={{ color: COLORS.call[c.resolution] }}> {resText(c.resolution)}</span>
              <EvidenceLine ev={c.evidence} onOpen={openEvidence} />
            </div>
          )) : "无"}
        </dd>
        <dt>被调用 {callees.length} <Tier t="T0" /></dt>
        <dd>
          {callees.length ? callees.map((c, i) => (
            <div key={i}>
              <button className="link" onClick={() => onNavigate({ kind: "symbols", file: c.to.split("::")[0] ?? "" }, `sym:${c.to}`)}>{c.to}</button>
              <span className="res" style={{ color: COLORS.call[c.resolution] }}> {resText(c.resolution)}</span>
              <EvidenceLine ev={c.evidence} onOpen={openEvidence} />
            </div>
          )) : "无"}
        </dd>
        <dt>未解析的调用 {unresolved.length}</dt>
        <dd>
          {unresolved.length ? unresolved.map((u, i) => (
            <div key={i} className={u.kind === "builtin" || u.kind === "external" ? "muted" : "amber"}>
              {u.callee} · {u.reason}
              <EvidenceLine ev={{ path: u.path, line: u.line }} onOpen={openEvidence} />
            </div>
          )) : "无"}
        </dd>
      </dl>
      {open ? <SourceBlock open={open} /> : null}
    </aside>
  );
}

function SourceBlock({ open }: { open: { ev: Evidence; excerpt?: SourceExcerpt; error?: string } }) {
  return (
    <div className="source-block">
      <div className="source-title">
        {open.ev.path}
        {open.ev.line ? `:${open.ev.line}` : ""}
      </div>
      {open.excerpt ? <Source excerpt={open.excerpt} target={open.ev.line ?? 0} /> : open.error ? <div className="red">{open.error}</div> : <div className="muted">读取中…</div>}
    </div>
  );
}
