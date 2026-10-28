import { SnapshotIndex, ago } from "./model.ts";
import { Tier } from "./Tier.tsx";
import type { Evidence } from "../../src/types.ts";

/** 顶栏一句话。 */
export function annotationSummaryText(ix: SnapshotIndex): { text: string; tone: "" | "amber" } | null {
  const a = ix.s.annotations;
  if (!a) return null;
  const s = a.summary;
  if (!s.total) return { text: `还没有人话标注（${s.todoDirs} 个目录、${s.todoFiles} 个文件待标）`, tone: "" };
  const bad = s.stale + s.orphan;
  return { text: `人话标注 ${s.total} 条${bad ? `，${s.stale} 条过时、${s.orphan} 条没对象` : ""}`, tone: bad ? "amber" : "" };
}

/** 节点面板里的「人话名字和职责」段。 */
export function AnnotationBlock({ ix, node, openEvidence }: { ix: SnapshotIndex; node: string; openEvidence: (ev: Evidence) => void }) {
  const a = ix.annotations.get(node);
  const has = Boolean(ix.s.annotations);
  return (
    <>
      <dt>人话名字和职责（标注） <Tier t="T2" /></dt>
      <dd className={a?.status === "fresh" ? "" : "muted"}>
        {a ? (
          <>
            <div>
              <b>{a.name}</b>：{a.role}
            </div>
            <div className="small">
              依据：
              {a.basis.map((b, i) => (
                <button key={i} className="evidence" onClick={() => openEvidence(b)} title="点开看这几行代码">
                  {b.path}{b.line ? `:${b.line}` : ""}{b.note ? <span className="note">{b.note}</span> : null}
                </button>
              ))}
              <span className="muted"> · {a.author} 写于 {ago(a.at)}</span>
            </div>
            {a.status === "stale" ? (
              <div className="amber small">代码变了，这条标注可能过时：写的时候 {a.hash.slice(0, 10)}，现在 {a.currentHash?.slice(0, 10)}（{a.hashBasis}）。等 AI 重写；重写前画布上不用它当名字。</div>
            ) : a.status === "orphan" ? (
              <div className="amber small">这个节点已经不存在了，标注没有对象。</div>
            ) : (
              <div className="small muted">和当前代码一致（哈希相同，{a.hashBasis}）</div>
            )}
          </>
        ) : (
          <span>{has ? "还没有标注。" : "还没开标注。"}{ix.s.annotations?.howTo ?? ""}</span>
        )}
      </dd>
    </>
  );
}

/** 空选状态下的「人话标注」总览。 */
export function AnnotationsOverview({ ix, openEvidence }: { ix: SnapshotIndex; openEvidence: (ev: Evidence) => void }) {
  const a = ix.s.annotations;
  if (!a) return null;
  const s = a.summary;
  const bad = a.items.filter((v) => v.status !== "fresh");
  return (
    <div className="tests">
      <h3>人话标注（谁写的名字，T2 声明）</h3>
      <p className="small">
        {s.total} 条：<span className="green">{s.fresh} 条和代码一致</span>
        {s.stale ? <span className="amber">、{s.stale} 条过时</span> : null}
        {s.orphan ? <span className="amber">、{s.orphan} 条没对象</span> : null}
        ；还有 {s.todoDirs} 个目录、{s.todoFiles} 个文件没标 <Tier t="T2" />
        <span className="muted"> 来源 {a.source}</span>
      </p>
      {bad.length ? (
        <div className="small">
          {bad.slice(0, 10).map((v) => (
            <div key={v.node} className="amber">
              {v.status === "stale" ? "过时" : "没对象"} · {v.node} · {v.name}
              {v.basis[0] ? <button className="link" onClick={() => openEvidence(v.basis[0]!)}>看依据</button> : null}
            </div>
          ))}
          {bad.length > 10 ? <div className="muted">… 另 {bad.length - 10} 条</div> : null}
        </div>
      ) : null}
      <p className="muted small">{a.howTo}</p>
    </div>
  );
}
