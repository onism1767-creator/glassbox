import { useEffect, useState } from "react";
import type { GNode, GEdge, Level } from "./model.ts";
import { SnapshotIndex, topDir, basename, COLORS } from "./model.ts";
import { resolutionText, unresolvedKindText, changeWord, kindWord, dirLabel, layerBadge, statusWord, WORDS } from "./words.ts";
import { fetchSource, type SourceExcerpt } from "./api.ts";
import { TestsSection, FileTests } from "./TestsSection.tsx";
import { AnnotationBlock, AnnotationsOverview } from "./Annotations.tsx";
import { Tier } from "./Tier.tsx";
import type { Evidence, FileEdge, CallEdge } from "../../src/types.ts";

export type Selection = { kind: "node"; g: GNode } | { kind: "edge"; e: GEdge } | { kind: "task"; id: string };

function EvidenceLine({ ev, onOpen, mark }: { ev: Evidence; onOpen: (ev: Evidence) => void; mark?: "violation" | "allowed" }) {
  return (
    <button className={`evidence${mark ? " " + mark : ""}`} onClick={() => onOpen(ev)} title="点开看这几行代码">
      {ev.path}
      {ev.line ? `:${ev.line}` : ""}
      {ev.note ? <span className="note">{ev.note}</span> : null}
      {mark === "violation" ? <span className="mark red">越层</span> : mark === "allowed" ? <span className="mark amber">白名单放行</span> : null}
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

function SourceBlock({ open }: { open: { ev: Evidence; excerpt?: SourceExcerpt; error?: string } }) {
  return (
    <div className="source-block">
      <div className="source-title">
        代码原文 · {open.ev.path}
        {open.ev.line ? `:${open.ev.line}` : ""}
      </div>
      {open.excerpt ? <Source excerpt={open.excerpt} target={open.ev.line ?? 0} /> : open.error ? <div className="red">{open.error}</div> : <div className="muted">读取中…</div>}
    </div>
  );
}

type OpenSource = { ev: Evidence; excerpt?: SourceExcerpt; error?: string } | null;

export function Panel({ ix, selection, onNavigate }: { ix: SnapshotIndex; selection: Selection | null; onNavigate: (level: Level, select?: string) => void }) {
  const [open, setOpen] = useState<OpenSource>(null);
  useEffect(() => setOpen(null), [selection]);
  const openEvidence = (ev: Evidence): void => {
    setOpen({ ev });
    fetchSource(ev.path, ev.line ?? 1)
      .then((excerpt) => setOpen({ ev, excerpt }))
      .catch((e: unknown) => setOpen({ ev, error: e instanceof Error ? e.message : String(e) }));
  };
  const s = ix.s;
  const markOf = (ev: Evidence): "violation" | "allowed" | undefined => {
    const key = `${ev.path}:${ev.line ?? 0}`;
    return ix.violationsAt.has(key) ? "violation" : ix.allowedAt.has(key) ? "allowed" : undefined;
  };

  if (!selection) {
    return (
      <aside className="panel">
        <h2>这张图在看什么</h2>
        <dl>
          <dt>现在看的是哪一版代码（来源）</dt>
          <dd>
            {s.source.commit ? `提交 ${s.source.commit.slice(0, 9)}` : "没有 git"} {s.source.branch ? `· 分支 ${s.source.branch}` : ""} {s.source.dirty ? "· 有还没提交的改动（工作区）" : ""}
          </dd>
          <dt>图是什么时候算出来的</dt>
          <dd>{s.generatedAt.replace("T", " ").slice(0, 19)}</dd>
          <dt>规模</dt>
          <dd>
            {s.files.length} 个文件 · {s.symbols.length} 个函数或类（符号） · {s.edges.length} 条 import 线 · {s.calls.edges.length} 条调用线
          </dd>
          <dt>分层规则从哪来（规则来源）</dt>
          <dd>
            {s.rules.provenance.length ? s.rules.provenance.map((p, i) => (
              <div key={i}>
                <Tier t={p.tier} /> {p.what === "layers" ? "哪个目录在第几层（分层）" : p.what === "allowed" ? "明文允许的例外（白名单）" : p.what.startsWith("forbidden words") ? `哪些词不能出现在 ${p.what.replace("forbidden words in ", "")} 里（禁用词）` : p.what}
                {p.evidence ? <EvidenceLine ev={p.evidence} onOpen={openEvidence} /> : null}
              </div>
            )) : "overlay 里没有声明分层"}
          </dd>
          <dt>层和目录的人话名字</dt>
          <dd>{Object.keys(ix.names.dirs).length ? <><Tier t={s.names.tier} /> 来自 overlay 的 names 段</> : "还没写，画布上只能显示目录名"}</dd>
          <dt>{WORDS.violations(s.violations.length)}</dt>
          <dd><Tier t="T1" /></dd>
          <dt>{WORDS.allowed(s.allowed.length)}</dt>
          <dd><Tier t="T1" /></dd>
          {s.history.latestStage ? (
            <>
              <dt>{WORDS.stage(s.history.latestStage)}</dt>
              <dd><Tier t="T0" /></dd>
            </>
          ) : null}
          <dt>这次会话的起点（基线）</dt>
          <dd>
            {s.baseline ? (
              <>
                提交 {s.baseline.baseline.commit.slice(0, 9)}，{s.baseline.baseline.reason}。{WORDS.baseline(s.baseline.commitsSince, s.baseline.changes.length)} <Tier t="T0" />
              </>
            ) : WORDS.noBaseline}
          </dd>
        </dl>
        <AnnotationsOverview ix={ix} openEvidence={openEvidence} />
        <TestsSection ix={ix} openEvidence={openEvidence} />
        <TechSection ix={ix} openEvidence={openEvidence} />
        <p className="hint">点一个方块看它是什么；点一条线看是哪几行代码把它们连起来的；双击方块往里看。</p>
        {open ? <SourceBlock open={open} /> : null}
      </aside>
    );
  }

  if (selection.kind === "edge") return <EdgePanel ix={ix} e={selection.e} openEvidence={openEvidence} markOf={markOf} open={open} />;
  if (selection.kind === "task") return <TaskPanel ix={ix} id={selection.id} openEvidence={openEvidence} open={open} onNavigate={onNavigate} />;

  const selected = selection.g;
  const ref = selected.ref;
  if (ref.kind === "portal") {
    return (
      <aside className="panel">
        <h2>{selected.label}</h2>
        <p>{selected.sub}。这是一个"门"：代表画布之外的东西，双击或点下面的按钮跳过去看。</p>
        <button className="primary" onClick={() => onNavigate(ref.target)}>
          跳过去看
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
        <h2>{ix.labelFor(`dir:${ref.dir}`, ref.dir === "." ? "根目录" : ref.dir, dirLabel(ref.dir, ix.names))}</h2>
        <dl>
          <AnnotationBlock ix={ix} node={`dir:${ref.dir}`} openEvidence={openEvidence} />
          <dt>在第几层（分层）</dt>
          <dd>
            {layer !== undefined ? (
              <>
                {layerBadge(layer, ix.names)} <Tier t={layerProv?.tier ?? "T2"} />
                {layerProv?.evidence ? <EvidenceLine ev={layerProv.evidence} onOpen={openEvidence} /> : null}
              </>
            ) : (
              "不在分层规则里"
            )}
          </dd>
          <dt>有多少文件</dt>
          <dd>{files.length} 个 <Tier t="T0" /></dd>
          <dt>它用了谁（import 出去）</dt>
          <dd>{out.length ? out.map((e) => <div key={e.to}>→ {dirLabel(e.to, ix.names)}，{e.count} 处{e.allowed ? `，其中 ${e.allowed} 处是白名单放行` : ""}{e.violations ? <span className="red">，其中 {e.violations} 处越层</span> : ""}</div>) : "没有"}</dd>
          <dt>谁用了它（被 import）</dt>
          <dd>{inn.length ? inn.map((e) => <div key={e.from}>← {dirLabel(e.from, ix.names)}，{e.count} 处</div>) : "没有"}</dd>
          <dt>越层调用（违规） <Tier t="T1" /></dt>
          <dd>{violations.length ? violations.map((v, i) => <div key={i} className="red">{v.message}<EvidenceLine ev={v.evidence} onOpen={openEvidence} /></div>) : "没有"}</dd>
          <dt>明文允许的例外（白名单放行） <Tier t="T1" /></dt>
          <dd>{allowed.length ? allowed.map((a, i) => <div key={i}><EvidenceLine ev={a.evidence} onOpen={openEvidence} />{a.allowedBy ? <span className="muted"> 允许它的规则写在 <EvidenceLine ev={a.allowedBy} onOpen={openEvidence} /></span> : null}</div>) : "没有"}</dd>
          <dt>这次会话改了的文件（相对基线） <Tier t="T0" /></dt>
          <dd>{changes.length ? changes.slice(0, 30).map((c) => <div key={c.path} style={{ color: COLORS.change[c.status] }}>{changeWord(c.status, !c.committed)} {c.path}</div>) : s.baseline ? "没有" : WORDS.noBaseline}{changes.length > 30 ? <div className="muted">… 另 {changes.length - 30} 个</div> : null}</dd>
        </dl>
        <button className="primary" onClick={() => onNavigate({ kind: "files", dir: ref.dir })}>
          展开看里面的文件
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
    const touch = ix.touched[ref.path];
    return (
      <aside className="panel">
        <h2>{ix.labelFor(`file:${ref.path}`, ref.path, ref.path)}</h2>
        <dl>
          <AnnotationBlock ix={ix} node={`file:${ref.path}`} openEvidence={openEvidence} />
          <dt>基本情况</dt>
          <dd>
            {f?.language} · {f ? `${(f.size / 1024).toFixed(1)} KB` : ""} · 这次会话{changeWord(change.status, change.uncommitted)} <Tier t="T0" />
            {touch ? <div className="purple">Claude 刚改过：{touch.at.replace("T", " ").slice(0, 19)}{touch.session ? `，会话 ${touch.session}` : ""}{touch.tool ? `，用 ${touch.tool}` : ""}</div> : null}
          </dd>
          <dt>它 import 了什么 <Tier t="T0" /></dt>
          <dd>
            {imports.length ? imports.map((r, i) => (
              <div key={i} className={r.status === "unresolved" ? "red" : r.status === "external" ? "muted" : ""}>
                {r.spec} → {r.status === "resolved" ? r.resolved : r.status === "external" ? "第三方库或标准库（外部）" : `项目里找不到（${r.reason ?? ""}）`}
              </div>
            )) : "没有"}
          </dd>
          <dt>谁 import 了它（被 import）</dt>
          <dd>{ins.length ? ins.map((e) => <div key={e.from}>← {e.from}，{e.evidence.length} 处</div>) : "没有"}</dd>
          <dt>越层调用（违规） <Tier t="T1" /></dt>
          <dd>{violations.length ? violations.map((v, i) => <div key={i} className="red">{v.message}<EvidenceLine ev={v.evidence} onOpen={openEvidence} /></div>) : "没有"}</dd>
          <dt>测试与覆盖率</dt>
          <FileTests ix={ix} path={ref.path} />
          <dt>里面的函数和类（符号） <Tier t="T0" /></dt>
          <dd>
            {symbols.length ? symbols.map((sym) => (
              <div key={sym.id}>
                <button className="link" onClick={() => onNavigate({ kind: "symbols", file: ref.path }, `sym:${sym.id}`)}>
                  {kindWord(sym.kind)} {sym.qualified}
                </button>
                <span className="muted"> 第 {sym.startLine}–{sym.endLine} 行</span>
              </div>
            )) : "没有（不是代码文件，或者里面没有定义）"}
          </dd>
          <dt>import 出去的线对应的代码行</dt>
          <dd>{outs.length ? outs.map((e) => <div key={e.to}>→ {e.to}{e.evidence.map((ev, i) => <EvidenceLine key={i} ev={ev} onOpen={openEvidence} mark={markOf(ev)} />)}</div>) : "没有"}</dd>
        </dl>
        {symbols.length ? (
          <button className="primary" onClick={() => onNavigate({ kind: "symbols", file: ref.path })}>
            展开看函数和类
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
  const symLink = (id: string) => (
    <button className="link" onClick={() => onNavigate({ kind: "symbols", file: id.split("::")[0] ?? "" }, `sym:${id}`)}>{id}</button>
  );
  return (
    <aside className="panel">
      <h2>{sym ? `${kindWord(sym.kind)} ${sym.qualified}` : selected.label}</h2>
      {sym ? (
        <p className="muted">
          在 {sym.path} 第 {sym.startLine}–{sym.endLine} 行 <Tier t="T0" />
          <button className="link" onClick={() => openEvidence({ path: sym.path, line: sym.startLine })}>看定义</button>
        </p>
      ) : null}
      <dl>
        <AnnotationBlock ix={ix} node={`sym:${ref.id}`} openEvidence={openEvidence} />
        <dt>谁调用了它（调用者 {callers.length}） <Tier t="T0" /></dt>
        <dd>
          {callers.length ? callers.map((c, i) => (
            <div key={i}>
              {symLink(c.from)}
              <span className="res" style={{ color: COLORS.call[c.resolution] }}> {resolutionText(c.resolution)}</span>
              <EvidenceLine ev={c.evidence} onOpen={openEvidence} />
            </div>
          )) : "没有人调用它（或者调用方式机器看不出来）"}
        </dd>
        <dt>它调用了谁（被调用者 {callees.length}） <Tier t="T0" /></dt>
        <dd>
          {callees.length ? callees.map((c, i) => (
            <div key={i}>
              {symLink(c.to)}
              <span className="res" style={{ color: COLORS.call[c.resolution] }}> {resolutionText(c.resolution)}</span>
              <EvidenceLine ev={c.evidence} onOpen={openEvidence} />
            </div>
          )) : "没有"}
        </dd>
        <dt>看不出调用了谁的地方（未解析 {unresolved.length}）</dt>
        <dd>
          {unresolved.length ? unresolved.map((u, i) => (
            <div key={i} className={u.kind === "builtin" || u.kind === "external" ? "muted" : "amber"}>
              {u.callee} · {unresolvedKindText(u.kind)}
              <EvidenceLine ev={{ path: u.path, line: u.line, note: u.reason }} onOpen={openEvidence} />
            </div>
          )) : "没有"}
        </dd>
      </dl>
      {open ? <SourceBlock open={open} /> : null}
    </aside>
  );
}

function TaskPanel({ ix, id, openEvidence, open, onNavigate }: { ix: SnapshotIndex; id: string; openEvidence: (ev: Evidence) => void; open: OpenSource; onNavigate: (level: Level, select?: string) => void }) {
  const tasks = ix.s.tasks;
  const t = tasks?.items.find((x) => x.id === id);
  if (!tasks || !t) return <aside className="panel"><h2>找不到任务 {id}</h2></aside>;
  const p = tasks.progress[t.id];
  const mine = tasks.inconsistencies.filter((i) => i.taskId === t.id);
  return (
    <aside className="panel">
      <h2>任务 {t.id} · {t.title}</h2>
      <p className="small">
        代码说：<b>{statusWord(p?.derived.status ?? t.status)}</b>{p?.derived.certainty === "推测" ? "（推测）" : ""} <Tier t={p?.derived.tier ?? "T2"} />
        <br />
        <span className="muted">{p?.derived.basis}</span>
      </p>
      <p className="muted small">
        文档写的是「{statusWord(t.status)}」，在 <EvidenceLine ev={t.source} onOpen={openEvidence} /> <Tier t={tasks.source.tier} />
        {p && p.derived.certainty !== "只有文档说法" && p.derived.status !== t.status ? <span className="amber"> 文档没跟着更新，以代码为准</span> : null}
      </p>
      <dl>
        {t.stage ? (<><dt>属于哪一步（阶段编号）</dt><dd>{t.stage.text}{t.parent ? `，上级 ${t.parent}` : ""}</dd></>) : null}
        {t.dates.first ? (<><dt>行里写的日期</dt><dd>{t.dates.first}{t.dates.last && t.dates.last !== t.dates.first ? ` 到 ${t.dates.last}` : ""}</dd></>) : null}
        {t.decided ? (<><dt>谁定的</dt><dd>{t.decided === "user" ? "用户拍板" : "Claude 提议，还没拍板"}</dd></>) : null}
        {t.testsClaimed ? (<><dt>行里声称的验收</dt><dd>{t.testsClaimed} 个测试全绿 <Tier t="T2" /><span className="muted">（还没接测试结果，无法核对）</span></dd></>) : null}
        <dt>进度是怎么算出来的 <Tier t="T1" /></dt>
        <dd>
          {p?.percent !== undefined ? <div className="bar big"><div className="fill" style={{ width: `${p.percent}%` }} /><span className="pct">{p.percent}%</span></div> : <div className="muted">没有机器可见的信号，不画进度条</div>}
          <div className="small muted">{p?.formula}</div>
          {p?.signals.map((s, i) => (
            <div key={i} className="signal">
              <span className={s.value === undefined ? "muted" : ""}>{s.text}</span> <Tier t={s.tier} /> <span className="muted small">来源：{s.source}</span>
            </div>
          ))}
        </dd>
        <dt>提到的文件（{t.filesTier === "T2" ? "任务声明的" : "从任务行里的反引号猜的"}） <Tier t={t.filesTier} /></dt>
        <dd>
          {t.files.length ? t.files.map((f) => (
            <div key={f}>
              {ix.files.has(f) ? <button className="link" onClick={() => onNavigate({ kind: "files", dir: f.includes("/") ? f.slice(0, f.indexOf("/")) : "." }, `file:${f}`)}>{f}</button> : <span className="muted">{f}（仓库里没有这个文件）</span>}
            </div>
          )) : "没有"}
        </dd>
        <dt>提到它的提交 <Tier t="T0" /></dt>
        <dd>{p?.commits.length ? p.commits.map((c) => <div key={c.sha}><span className="muted">{c.date.slice(0, 10)} {c.sha.slice(0, 7)}</span> {c.subject}</div>) : "没有"}</dd>
        {mine.length ? (<><dt>文档和代码对不上的地方</dt><dd>{mine.map((i, k) => <div key={k} className={i.severity === "warn" ? "amber" : "muted"}>{i.kind}：{i.text}</div>)}</dd></>) : null}
        {t.criteria.length ? (<><dt>验收标准（任务文件里的复选框）</dt><dd>{t.criteria.map((c, k) => <div key={k}>{c.done ? "☑" : "☐"} {c.text}</div>)}</dd></>) : null}
      </dl>
      {open ? <SourceBlock open={open} /> : null}
    </aside>
  );
}

function TechSection({ ix, openEvidence }: { ix: SnapshotIndex; openEvidence: (ev: Evidence) => void }) {
  const tech = ix.s.tech;
  const [showStd, setShowStd] = useState(false);
  if (!tech) return <div className="tech muted small">这个快照还没有技术栈数据，重启服务后再看。</div>;
  const third = tech.used.filter((u) => u.kind === "third-party");
  const std = tech.used.filter((u) => u.kind !== "third-party");
  const manifests = [...new Set(tech.declared.map((d) => d.file))];
  return (
    <div className="tech">
      <h3>用到的技术（技术栈）</h3>
      <p className="muted small">
        左边是代码里实际 import 的第三方库 <Tier t={tech.tiers.used} />，右边是依赖清单里声明的版本 <Tier t={tech.tiers.declared} />。
        {manifests.length ? ` 清单：${manifests.join("、")}。` : " 没找到 pyproject.toml、package.json 或 requirements.txt。"}
      </p>
      {third.length ? (
        <table className="tech-table">
          <tbody>
            {third.map((u) => (
              <tr key={u.module} className={u.declared ? "" : "undeclared"}>
                <td className="name">{u.module}</td>
                <td className="muted">{u.imports} 处 import · {u.files} 个文件</td>
                <td className="spec">{u.declared ? <button className="link" onClick={() => openEvidence({ path: u.declared!.file, line: 1 })}>{u.declared.spec}{u.declared.dev ? "（开发用）" : ""}</button> : <span className="amber">清单里没找到</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div className="muted">代码里没有 import 第三方库</div>}
      {tech.unused.length ? (
        <div className="small">
          <span className="muted">声明了但代码里没见 import（{tech.unused.length}）：</span> {tech.unused.map((d) => d.name + (d.dev ? "（开发用）" : "")).join("、")}
        </div>
      ) : null}
      <div className="small">
        <button className="link" onClick={() => setShowStd((v) => !v)}>
          {showStd ? "收起" : "展开"}语言自带的标准库（{std.length} 个）
        </button>
        {showStd ? <div className="muted">{std.map((u) => `${u.module} ${u.imports}`).join("、")}</div> : null}
      </div>
    </div>
  );
}

function EdgePanel({ ix, e, openEvidence, markOf, open }: { ix: SnapshotIndex; e: GEdge; openEvidence: (ev: Evidence) => void; markOf: (ev: Evidence) => "violation" | "allowed" | undefined; open: OpenSource }) {
  const ref = e.ref;
  let title = "";
  let intro = "";
  let fileEdges: FileEdge[] = [];
  let callEdges: CallEdge[] = [];
  if (ref.kind === "dir-edge") {
    title = `${dirLabel(ref.from, ix.names)} 用了 ${dirLabel(ref.to, ix.names)}`;
    fileEdges = ix.fileEdgesBetweenDirs(ref.from, ref.to);
    intro = `这条线是 ${fileEdges.length} 对文件之间的 import 合起来画的，一共 ${e.count} 处。箭头从用的人指向被用的人。`;
  } else if (ref.kind === "file-edge") {
    title = `${ref.from} 用了 ${ref.to}`;
    fileEdges = ix.s.edges.filter((x) => x.from === ref.from && x.to === ref.to);
    intro = `这条线由下面这些 import 语句构成。`;
  } else if (ref.kind === "file-portal") {
    const inDir = (p: string) => topDir(p) === ref.dir;
    fileEdges = ref.direction === "out" ? ix.s.edges.filter((x) => inDir(x.from) && topDir(x.to) === ref.otherDir) : ix.s.edges.filter((x) => inDir(x.to) && topDir(x.from) === ref.otherDir);
    title = ref.direction === "out" ? `${dirLabel(ref.dir, ix.names)} 里的文件用了 ${dirLabel(ref.otherDir, ix.names)}` : `${dirLabel(ref.otherDir, ix.names)} 用了 ${dirLabel(ref.dir, ix.names)} 里的文件`;
    intro = `这条线通向画布外的目录，合并了 ${fileEdges.length} 对文件之间的 import。`;
  } else if (ref.kind === "call-edge") {
    title = `${ref.from.split("::")[1] ?? ref.from} 调用了 ${ref.to.split("::")[1] ?? ref.to}`;
    callEdges = ix.s.calls.edges.filter((x) => x.from === ref.from && x.to === ref.to);
    intro = `调用了 ${callEdges.length} 次，每一次对应下面一行代码。`;
  } else {
    const inFile = (id: string) => id.split("::")[0] === ref.file;
    callEdges = ref.direction === "out" ? ix.s.calls.edges.filter((x) => inFile(x.from) && x.to.split("::")[0] === ref.otherFile) : ix.s.calls.edges.filter((x) => inFile(x.to) && x.from.split("::")[0] === ref.otherFile);
    title = ref.direction === "out" ? `${basename(ref.file)} 调用了 ${ref.otherFile} 里的函数` : `${ref.otherFile} 调用了 ${basename(ref.file)} 里的函数`;
    intro = `这条线通向画布外的文件，合并了 ${callEdges.length} 次调用。`;
  }
  return (
    <aside className="panel">
      <h2>这条线：{title}</h2>
      <p className="muted">{intro} <Tier t="T0" /></p>
      {fileEdges.length ? (
        <dl>
          <dt>构成这条线的 import 语句（点开看代码）</dt>
          <dd>
            {fileEdges.map((fe) => (
              <div key={`${fe.from}>${fe.to}`} className="edge-group">
                <div className="edge-pair">{fe.from} → {fe.to}</div>
                {fe.evidence.map((ev, i) => <EvidenceLine key={i} ev={ev} onOpen={openEvidence} mark={markOf(ev)} />)}
              </div>
            ))}
          </dd>
        </dl>
      ) : null}
      {callEdges.length ? (
        <dl>
          <dt>构成这条线的调用（点开看代码）</dt>
          <dd>
            {callEdges.map((ce, i) => (
              <div key={i} className="edge-group">
                <div className="edge-pair">{ce.from} → {ce.to} <span className="res" style={{ color: COLORS.call[ce.resolution] }}>{resolutionText(ce.resolution)}</span></div>
                <EvidenceLine ev={ce.evidence} onOpen={openEvidence} />
              </div>
            ))}
          </dd>
        </dl>
      ) : null}
      {open ? <SourceBlock open={open} /> : null}
    </aside>
  );
}
