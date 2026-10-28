import { SnapshotIndex, ago, topDir, type Level } from "./model.ts";
import { Tier } from "./Tier.tsx";
import type { Evidence } from "../../src/types.ts";
import type { JourneyView, LinkView } from "../../src/journeys.ts";

const STATUS: Record<JourneyView["status"], { word: string; tone: string }> = {
  verified: { word: "已验证", tone: "green" },
  "verified-stale": { word: "验证过时", tone: "amber" },
  failed: { word: "验证没过", tone: "red" },
  broken: { word: "断链", tone: "red" },
  hypothesis: { word: "假设", tone: "muted" },
  invalid: { word: "步骤不存在", tone: "amber" },
};

/** 顶栏一句话。 */
export function journeySummaryText(ix: SnapshotIndex): { text: string; tone: string } | null {
  const j = ix.s.journeys;
  if (!j || !j.summary.total) return null;
  const s = j.summary;
  const bad = s.failed + s.broken + s.invalid;
  return { text: `旅程 ${s.total} 条：${s.verified} 条已验证${s.stale ? `、${s.stale} 条验证过时` : ""}${bad ? `、${bad} 条有问题` : ""}`, tone: bad ? "red" : s.stale ? "amber" : s.verified ? "green" : "" };
}

function linkClass(l: LinkView): string {
  return l.kind === "broken" || l.kind === "missing" ? "link bad" : "link";
}

/** 空选面板里的旅程清单。 */
export function JourneysOverview({ ix, onJourney }: { ix: SnapshotIndex; onJourney: (id: string | null, step: number) => void }) {
  const j = ix.s.journeys;
  if (!j) return null;
  return (
    <div className="tests">
      <h3>旅程（从入口依次经过哪些代码）</h3>
      {j.items.length ? (
        j.items.map((it) => (
          <div key={it.id} className="journey-row" onClick={() => onJourney(it.id, 0)} title={it.statusText}>
            <b>{it.name}</b>
            <span className={`st ${STATUS[it.status].tone}`}>{STATUS[it.status].word}</span>
            {it.status === "verified" ? <Tier t="T3" /> : null}
            <div className="small muted">{it.steps.length} 步 · {it.role}</div>
          </div>
        ))
      ) : (
        <p className="muted small">还没有旅程。{j.howTo}</p>
      )}
      <p className="muted small">
        入口候选 {j.entries.length} 个（路由、CLI、main，机器扫出来的）
        {j.entries.slice(0, 6).map((e) => (
          <span key={`${e.path}:${e.line}`}> · {e.text}</span>
        ))}
        {j.entries.length > 6 ? " · …" : ""}
      </p>
    </div>
  );
}

export function JourneyPanel({ ix, id, step, openEvidence, onNavigate, onJourney, children }: { ix: SnapshotIndex; id: string; step: number; openEvidence: (ev: Evidence) => void; onNavigate: (level: Level, select?: string) => void; onJourney: (id: string | null, step: number) => void; children?: React.ReactNode }) {
  const j = ix.journeys.get(id);
  if (!j) {
    return (
      <aside className="panel">
        <h2>旅程不见了</h2>
        <p className="muted">这条旅程已经不在清单里。</p>
        <button className="link" onClick={() => onJourney(null, 0)}>收起</button>
      </aside>
    );
  }
  const cur = Math.max(0, Math.min(step, j.steps.length - 1));
  const st = STATUS[j.status];
  // 只把画布带到那一步所在的层，不选中方块：选中会把面板换成方块的，旅程面板就没了；当前步靠紫圈标出。
  const goto = (i: number) => {
    const s = j.steps[i];
    if (!s?.file) return;
    if (s.node.startsWith("sym:")) onNavigate({ kind: "symbols", file: s.file });
    else onNavigate({ kind: "files", dir: topDir(s.file) });
  };
  const v = j.verification;
  return (
    <aside className="panel">
      <h2>{j.name}</h2>
      <p>
        {j.role} <span className="muted small">· {j.author} 写于 {ago(j.at)}</span>
      </p>
      <dl>
        <dt>现在是什么状态 {j.status === "verified" ? <Tier t="T3" /> : <Tier t="T2" />}</dt>
        <dd>
          <b className={st.tone}>{st.word}</b>：{j.statusText}
          {j.hint ? <div className="muted small">{j.hint}</div> : null}
          {v ? (
            <div className="small muted">
              验证于 {ago(v.at)}：跑了 {v.tests.join("、")}，通过 {v.passed}、失败 {v.failed}，真实碰到 {v.touched.length} 个文件，其中 {v.stepsTouched} / {j.steps.length} 步
            </div>
          ) : j.verify?.tests.length ? (
            <div className="small muted">验证用的测试：{j.verify.tests.join("、")}。跑 <code>glassbox journey verify {j.id}</code></div>
          ) : (
            <div className="small muted">没指定验证用的测试，所以只能静态检验。</div>
          )}
        </dd>
        <dt>一步一步（相邻两步之间的连接是机器在 import 和调用图上找的） <Tier t="T1" /></dt>
        <dd>
          <ol className="journey-steps">
            {j.steps.map((s, i) => (
              <li key={i} className={i === cur ? "focus" : ""} onClick={() => onJourney(id, i)}>
                <span className={s.touched === false ? "red" : s.touched ? "green" : ""}>{s.touched === true ? "● " : s.touched === false ? "○ " : ""}</span>
                <b>{i + 1}.</b> {ix.labelFor(s.node, s.label, s.label)}
                {s.note ? <span className="muted"> · {s.note}</span> : null}
                {!s.exists ? <span className="amber"> · 已不存在</span> : null}
                {s.changedSinceVerify ? <span className="amber"> · 验证后代码变了</span> : null}
                {s.touchedBy?.length ? <span className="muted small"> · 上次全量跑时 {s.touchedBy.length} 个指定测试碰过它</span> : null}
                {s.file ? (
                  <button className="link" onClick={(e) => { e.stopPropagation(); goto(i); }}>
                    在画布上看
                  </button>
                ) : null}
                {j.links[i] ? (
                  <div className={linkClass(j.links[i]!)}>
                    {j.links[i]!.kind === "broken" || j.links[i]!.kind === "missing" ? "✗ " : "↓ "}
                    {j.links[i]!.text}
                    {j.links[i]!.via.length > 2 ? <span> ：{j.links[i]!.via.join(" → ")}</span> : null}
                    {j.links[i]!.evidence.slice(0, 3).map((ev, k) => (
                      <button key={k} className="evidence" onClick={() => openEvidence(ev)} title="点开看这几行代码">
                        {ev.path}{ev.line ? `:${ev.line}` : ""}
                      </button>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
          <div className="journey-nav">
            <button className="crumb" disabled={cur === 0} onClick={() => { onJourney(id, cur - 1); goto(cur - 1); }}>上一步</button>
            <button className="crumb" disabled={cur >= j.steps.length - 1} onClick={() => { onJourney(id, cur + 1); goto(cur + 1); }}>下一步</button>
            <button className="crumb" onClick={() => goto(cur)}>看第 {cur + 1} 步</button>
            <button className="link" onClick={() => onJourney(null, 0)}>收起旅程</button>
          </div>
        </dd>
      </dl>
      {children}
    </aside>
  );
}
