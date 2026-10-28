import { useState } from "react";
import { SnapshotIndex } from "./model.ts";
import { Tier } from "./Tier.tsx";
import type { Evidence } from "../../src/types.ts";

/** 顶栏一句话。 */
export function architectureSummaryText(ix: SnapshotIndex): { text: string; tone: string } | null {
  const a = ix.s.architecture;
  if (!a) return null;
  const s = a.summary;
  return { text: `架构落地 ${s.rate}%（书里写了 ${s.declared} 项，缺 ${s.missing}）`, tone: s.missing ? "amber" : "green" };
}

const KIND: Record<string, string> = { file: "文件", dir: "目录", class: "类", function: "函数" };

/** 空选面板里的「架构落地率」段。 */
export function ArchitectureOverview({ ix, openEvidence }: { ix: SnapshotIndex; openEvidence: (ev: Evidence) => void }) {
  const a = ix.s.architecture;
  const [showAll, setShowAll] = useState(false);
  const [showExtra, setShowExtra] = useState(false);
  if (!a) return null;
  const s = a.summary;
  const missing = a.declarations.filter((d) => d.status === "missing" && !d.weak);
  return (
    <div className="tests">
      <h3>架构落地率（架构书写的，代码里有没有）</h3>
      <p className="small">
        <b className={s.missing ? "amber" : "green"}>{s.rate}%</b>：架构书声明了 {s.declared} 项（文件和目录 {s.files.declared}、类和函数 {s.symbols.declared}），代码里存在 {s.present}，缺 {s.missing} <Tier t="T2" />
        <span className="muted"> 对照 </span>
        <Tier t="T0" />
        <span className="muted"> 来源 <button className="evidence" onClick={() => openEvidence({ path: a.source.file, line: 1 })}>{a.source.file}</button></span>
      </p>
      {a.byChapter.some((c) => c.missing.length) ? (
        <div className="small">
          {a.byChapter.filter((c) => c.missing.length).map((c) => (
            <div key={c.chapter} className="amber">
              {c.chapter}：{c.present} / {c.declared}，缺 {c.missing.slice(0, 4).join("、")}{c.missing.length > 4 ? "…" : ""}
            </div>
          ))}
          <div className="muted">另 {a.byChapter.filter((c) => c.declared && !c.missing.length).length} 个章节全部落地</div>
        </div>
      ) : null}
      {missing.length ? (
        <div className="small">
          <button className="link" onClick={() => setShowAll((v) => !v)}>{showAll ? "收起" : "展开"}缺失的 {missing.length} 项（蓝图还没落地，或改了名没改书）</button>
          {showAll
            ? missing.map((d) => (
                <div key={`${d.kind}:${d.name}`} className="amber">
                  {KIND[d.kind]} {d.name}
                  <button className="evidence" onClick={() => openEvidence(d.evidence)}>{d.evidence.path}:{d.evidence.line}</button>
                  {d.hint ? <span className="muted"> {d.hint}</span> : null}
                </div>
              ))
            : null}
        </div>
      ) : null}
      {a.weak.missing.length ? (
        <div className="small muted">
          正文里还提到 {a.weak.present + a.weak.missing.length} 个驼峰词，{a.weak.present} 个代码里有；没有的 {a.weak.missing.length} 个不算进落地率（常是产品名或外部名字）：{a.weak.missing.slice(0, 8).map((w) => w.name).join("、")}{a.weak.missing.length > 8 ? "…" : ""}
        </div>
      ) : null}
      <div className="small">
        <button className="link" onClick={() => setShowExtra((v) => !v)}>{showExtra ? "收起" : "展开"}代码里有、架构书没提的（目录 {a.extra.dirs.length}、文件 {a.extra.files}、类 {a.extra.classes.length}）</button>
        {showExtra ? (
          <div className="muted">
            {a.extra.dirs.length ? <div>目录：{a.extra.dirs.join("、")}</div> : null}
            {a.extra.classes.slice(0, 30).map((c) => (
              <div key={`${c.path}:${c.line}`}>
                类 {c.name}
                <button className="evidence" onClick={() => openEvidence({ path: c.path, line: c.line })}>{c.path}:{c.line}</button>
              </div>
            ))}
            {a.extra.classes.length > 30 ? <div>… 另 {a.extra.classes.length - 30} 个类</div> : null}
          </div>
        ) : null}
      </div>
      <p className="muted small">{a.howTo}</p>
    </div>
  );
}
