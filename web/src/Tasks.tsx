import { useState } from "react";
import type { SnapshotIndex } from "./model.ts";
import { statusWord } from "./words.ts";
import { Tier } from "./Tier.tsx";
import type { TaskRecord } from "../../src/tasks.ts";
import type { TaskProgress } from "../../src/progress.ts";

function Bar({ p }: { p?: TaskProgress }) {
  if (!p || p.percent === undefined) return <div className="bar none" title="没有机器可见的信号，不画进度条">没有进度数据</div>;
  return (
    <div className="bar" title={p.formula}>
      <div className={`fill ${p.derived.status}`} style={{ width: `${p.percent}%` }} />
      <span className="pct">{p.percent}%</span>
    </div>
  );
}

function Row({ t, p, selected, onSelect }: { t: TaskRecord; p?: TaskProgress; selected: boolean; onSelect: (id: string | null) => void }) {
  const files = t.files.length;
  const changedSignal = p?.signals.find((s) => s.name === "文件改动");
  const testSignal = p?.signals.find((s) => s.name === "测试" && s.value !== undefined);
  const claim = p?.signals.find((s) => s.name === "验收声明");
  const derived = p?.derived.status ?? t.status;
  const docDiffers = p && p.derived.certainty !== "只有文档说法" && p.derived.status !== t.status;
  return (
    <div className={`task-row ${derived}${selected ? " selected" : ""}`} onClick={() => onSelect(selected ? null : t.id)} title={p?.derived.basis}>
      <div className="task-head">
        <span className="task-id">{t.id}</span>
        <span className="task-title">{t.title}</span>
        <span className={`task-status ${derived}`}>{statusWord(derived)}{p?.derived.certainty === "推测" ? "？" : ""}</span>
      </div>
      <Bar p={p} />
      <div className="task-meta">
        {docDiffers ? <span className="amber">文档写的还是「{statusWord(t.status)}」 · </span> : null}
        {p?.derived.certainty === "只有文档说法" ? <span className="muted">代码里没痕迹，照文档 · </span> : null}
        {files ? <span>{changedSignal?.text ?? `提到 ${files} 个文件`}</span> : <span className="muted">没提到具体文件，不能在图上高亮</span>}
        {p?.commits.length ? <span> · {p.commits.length} 个提交提到它</span> : null}
        {testSignal ? <span className={(p?.testsFailed ?? 0) > 0 ? "red" : "green"}> · {testSignal.text}</span> : null}
        {claim ? <span className={claim.value ? "green" : "amber"}> · {claim.value ? "验收声明核对一致" : "验收声明对不上"}</span> : null}
        {p?.active ? <span className="purple"> · Claude 正在改</span> : null}
      </div>
    </div>
  );
}

export function Tasks({ ix, selectedTaskId, onSelect, onClose }: { ix: SnapshotIndex; selectedTaskId: string | null; onSelect: (id: string | null) => void; onClose: () => void }) {
  const [showDone, setShowDone] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const tasks = ix.s.tasks;
  if (!tasks) {
    return (
      <aside className="tasks">
        <div className="tasks-head"><span>任务</span><button className="link" onClick={onClose}>收起</button></div>
        <p className="muted small">还没有任务来源。在 overlay.yaml 里写 <code>tasks: {"{ file: docs/任务列表.md }"}</code>，或在 .workbench/tasks/ 里放任务文件。</p>
      </aside>
    );
  }
  const items = tasks.items;
  const derivedOf = (t: TaskRecord) => tasks.progress[t.id]?.derived.status ?? t.status;
  const developing = items.filter((t) => ["developing", "review", "rework"].includes(derivedOf(t)));
  const todo = items.filter((t) => derivedOf(t) === "todo");
  const done = items.filter((t) => !developing.includes(t) && !todo.includes(t));
  const g = tasks.gauge;
  const warns = tasks.inconsistencies.filter((i) => i.severity === "warn");
  const infos = tasks.inconsistencies.filter((i) => i.severity === "info");
  const key = (t: TaskRecord) => `${t.id}@${t.source.line}`;
  return (
    <aside className="tasks">
      <div className="tasks-head">
        <span>任务与进度（以代码为准）</span>
        <button className="link" onClick={onClose}>收起</button>
      </div>
      <section className="gauge">
        <h3>项目到哪一步了</h3>
        <div className="gauge-row">
          <span className="k">代码说</span>
          <span className="v">{g.code.current ? `最近的提交标到 ${g.code.current}${g.code.at ? `（${g.code.at.slice(5, 16).replace("T", " ")}）` : ""}` : "提交信息里没有阶段标签"} · 按代码判断完成 {g.code.derivedDone} / {g.doc.total}，正在做 {g.code.derivedDeveloping}</span>
          <Tier t={g.code.tier} />
        </div>
        <div className="gauge-row">
          <span className="k">文档写的</span>
          <span className="v">{g.doc.current ? `${g.doc.current}` : "没有阶段编号"} · 文档自己勾了 {g.doc.done} / {g.doc.total}{g.stale ? <span className="amber">，{g.stale} 项没跟着代码更新</span> : null}</span>
          <Tier t={g.doc.tier} />
        </div>
        <div className="muted small">任务清单读自 {tasks.source.file}{tasks.source.readAt ? `，${tasks.source.readAt.slice(5, 16).replace("T", " ")} 读的` : ""}；清单只提供"有哪些任务"，做没做完看代码。</div>
      </section>
      {warns.length ? (
        <section>
          <h3 className="amber">值得看一眼（{warns.length}）</h3>
          {warns.map((i, k) => (
            <div key={k} className="inconsistency warn" onClick={() => i.taskId && onSelect(i.taskId)}>
              <span className="kind">{i.kind}</span> {i.text}
            </div>
          ))}
        </section>
      ) : null}
      <section>
        <h3>正在做（{developing.length}）</h3>
        {developing.length ? developing.map((t) => <Row key={key(t)} t={t} p={tasks.progress[t.id]} selected={selectedTaskId === t.id} onSelect={onSelect} />) : <div className="muted small">按代码判断没有正在做的任务</div>}
      </section>
      <section>
        <h3>待做（{todo.length}）</h3>
        {todo.slice(0, 12).map((t) => <Row key={key(t)} t={t} p={tasks.progress[t.id]} selected={selectedTaskId === t.id} onSelect={onSelect} />)}
        {todo.length > 12 ? <div className="muted small">… 另 {todo.length - 12} 个</div> : null}
      </section>
      <section>
        <h3>
          <button className="link" onClick={() => setShowDone((v) => !v)}>{showDone ? "收起" : "展开"}按代码判断已完成（{done.length}）</button>
        </h3>
        {showDone ? done.map((t) => <Row key={key(t)} t={t} p={tasks.progress[t.id]} selected={selectedTaskId === t.id} onSelect={onSelect} />) : null}
      </section>
      {infos.length ? (
        <section>
          <h3>
            <button className="link" onClick={() => setShowInfo((v) => !v)}>{showInfo ? "收起" : "展开"}文档可以更新的地方（{infos.length}）</button>
          </h3>
          {showInfo ? infos.map((i, k) => (
            <div key={k} className="inconsistency info" onClick={() => i.taskId && onSelect(i.taskId)}>
              <span className="kind">{i.kind}</span> {i.text}
            </div>
          )) : null}
        </section>
      ) : null}
    </aside>
  );
}
