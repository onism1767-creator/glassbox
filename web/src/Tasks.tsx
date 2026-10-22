import { useState } from "react";
import type { SnapshotIndex } from "./model.ts";
import { statusWord, tierText } from "./words.ts";
import type { TaskRecord } from "../../src/tasks.ts";
import type { TaskProgress } from "../../src/progress.ts";

function Tier({ t }: { t: string }) {
  return <span className={`tier ${t}`} title={tierText(t)}>{tierText(t)}</span>;
}

function Bar({ p }: { p?: TaskProgress }) {
  if (!p || p.percent === undefined) return <div className="bar none" title="没有机器可见的信号，不画进度条">没有进度数据</div>;
  return (
    <div className="bar" title={p.formula}>
      <div className="fill" style={{ width: `${p.percent}%` }} />
      <span className="pct">{p.percent}%</span>
    </div>
  );
}

function Row({ t, p, selected, onSelect }: { t: TaskRecord; p?: TaskProgress; selected: boolean; onSelect: (id: string | null) => void }) {
  const files = t.files.length;
  const changedSignal = p?.signals.find((s) => s.name === "文件改动");
  return (
    <div className={`task-row ${t.status}${selected ? " selected" : ""}`} onClick={() => onSelect(selected ? null : t.id)}>
      <div className="task-head">
        <span className="task-id">{t.id}</span>
        <span className="task-title">{t.title}</span>
        <span className={`task-status ${t.status}`}>{statusWord(t.status)}</span>
      </div>
      <Bar p={p} />
      <div className="task-meta">
        {files ? <span>{changedSignal?.text ?? `提到 ${files} 个文件`}</span> : <span className="muted">没提到具体文件，不能在图上高亮</span>}
        {p?.commits.length ? <span> · {p.commits.length} 个提交提到它</span> : null}
        {p?.active ? <span className="purple"> · Claude 正在改</span> : null}
      </div>
    </div>
  );
}

export function Tasks({ ix, selectedTaskId, onSelect, onClose }: { ix: SnapshotIndex; selectedTaskId: string | null; onSelect: (id: string | null) => void; onClose: () => void }) {
  const [showDone, setShowDone] = useState(false);
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
  const developing = items.filter((t) => t.status === "developing" || t.status === "review" || t.status === "rework");
  const todo = items.filter((t) => t.status === "todo");
  const done = items.filter((t) => t.status === "done" || t.status === "passed" || t.status === "integrated" || t.status === "integration-passed" || t.status === "handtest" || t.status === "integration-review");
  const g = tasks.gauge;
  return (
    <aside className="tasks">
      <div className="tasks-head">
        <span>任务与进度</span>
        <button className="link" onClick={onClose}>收起</button>
      </div>
      <section className="gauge">
        <h3>项目到哪一步了</h3>
        <div className="gauge-row">
          <span className="k">任务列表说</span>
          <span className="v">{g.doc.current ? `正在 ${g.doc.current}` : "没有阶段编号"} · 完成 {g.doc.done} / {g.doc.total}</span>
          <Tier t={g.doc.tier} />
        </div>
        <div className="gauge-row">
          <span className="k">提交信息说</span>
          <span className="v">{g.code.current ? `最近标到 ${g.code.current}${g.code.at ? `（${g.code.at.slice(5, 16).replace("T", " ")}）` : ""}` : "没有阶段标签"}</span>
          <Tier t={g.code.tier} />
        </div>
        <div className={`gauge-verdict ${g.relation === "一致" ? "ok" : g.relation === "无法比较" ? "muted" : "bad"}`}>{g.relation}：{g.text}</div>
        <div className="muted small">来源：{tasks.source.file}（{tasks.source.format}） <Tier t={tasks.source.tier} /></div>
      </section>
      {tasks.inconsistencies.length ? (
        <section>
          <h3 className="red">对不上的地方（{tasks.inconsistencies.length}）</h3>
          {tasks.inconsistencies.map((i, k) => (
            <div key={k} className="inconsistency" onClick={() => i.taskId && onSelect(i.taskId)}>
              <span className="kind">{i.kind}</span> {i.text}
            </div>
          ))}
        </section>
      ) : null}
      <section>
        <h3>正在做（{developing.length}）</h3>
        {developing.length ? developing.map((t) => <Row key={`${t.id}@${t.source.line}`} t={t} p={tasks.progress[t.id]} selected={selectedTaskId === t.id} onSelect={onSelect} />) : <div className="muted small">没有标为正在做的任务</div>}
      </section>
      <section>
        <h3>待做（{todo.length}）</h3>
        {todo.slice(0, 12).map((t) => <Row key={`${t.id}@${t.source.line}`} t={t} p={tasks.progress[t.id]} selected={selectedTaskId === t.id} onSelect={onSelect} />)}
        {todo.length > 12 ? <div className="muted small">… 另 {todo.length - 12} 个</div> : null}
      </section>
      <section>
        <h3>
          <button className="link" onClick={() => setShowDone((v) => !v)}>{showDone ? "收起" : "展开"}已完成（{done.length}）</button>
        </h3>
        {showDone ? done.map((t) => <Row key={`${t.id}@${t.source.line}`} t={t} p={tasks.progress[t.id]} selected={selectedTaskId === t.id} onSelect={onSelect} />) : null}
      </section>
    </aside>
  );
}
