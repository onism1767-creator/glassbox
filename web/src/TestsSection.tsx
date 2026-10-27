import { useState } from "react";
import type { SnapshotIndex } from "./model.ts";
import { ago } from "./model.ts";
import { tierText } from "./words.ts";
import type { Evidence } from "../../src/types.ts";

function Tier({ t }: { t: string }) {
  return <span className={`tier ${t}`} title={tierText(t)}>{tierText(t)}</span>;
}

export function testSummaryText(ix: SnapshotIndex): { text: string; bad: boolean } {
  const r = ix.s.tests?.run;
  if (!r) return { text: "还没有测试结果", bad: false };
  const bad = r.failed + r.errors > 0;
  return { text: `测试 ${r.passed} 通过${bad ? `、${r.failed + r.errors} 失败` : ""}${r.skipped ? `、${r.skipped} 跳过` : ""}（${ago(r.at)}跑的）`, bad };
}

/** 空选状态下的「测试结果」段。 */
export function TestsSection({ ix, openEvidence }: { ix: SnapshotIndex; openEvidence: (ev: Evidence) => void }) {
  const t = ix.s.tests;
  const [showFails, setShowFails] = useState(true);
  if (!t) return null;
  if (!t.run) {
    return (
      <div className="tests">
        <h3>测试结果</h3>
        <p className="muted small">还没有测试结果。{t.howTo}</p>
      </div>
    );
  }
  const r = t.run;
  const fails = r.cases.filter((c) => c.status === "failed" || c.status === "error");
  const p = r.partial;
  return (
    <div className="tests">
      <h3>测试结果（最近一次跑的）</h3>
      <p className="small">
        <b className={fails.length ? "red" : "green"}>{r.passed} 通过、{r.failed + r.errors} 失败、{r.skipped} 跳过</b>，共 {r.total} 个，{r.at.replace("T", " ").slice(0, 19)} <Tier t="T0" />
        <span className="muted"> 来源 {r.source}</span>
      </p>
      {p ? (
        <p className="small">
          <b className={p.failed ? "red" : "green"}>最近一次自动跑（{ago(p.at)}）</b>：改了 {p.changed.join("、")} → 只跑了 {p.ran} 个相关{p.granularity === "file" ? "测试文件里的" : ""}用例：通过 {p.passed}、失败 {p.failed}、跳过 {p.skipped}，{(p.elapsedMs / 1000).toFixed(1)} 秒
          {p.items.map((i) => (
            <span key={i.path} className="muted"> · {i.path}：{i.how}{i.tier ? <Tier t={i.tier} /> : null}</span>
          ))}
          {p.skippedFiles.length ? <span className="amber"> · 没跑：{p.skippedFiles.map((s) => `${s.path}（${s.why}）`).join("、")}</span> : null}
          {r.fullAt ? <span className="muted"> · 其余用例的结果来自 {ago(r.fullAt)}的全量跑</span> : null}
        </p>
      ) : null}
      {t.auto ? (
        <p className="muted small">
          {t.auto.enabled ? `改了 .py 文件会自动只跑相关测试（${t.auto.python ?? "python"}）` : `自动跑相关测试：关。${t.auto.why ?? ""}`}
        </p>
      ) : null}
      {t.coverage ? (
        <p className="small">
          代码被测试跑到的比例（覆盖率）{t.coverage.totalPercent}%{t.coverage.hasContexts ? "，而且知道每个测试跑过哪些文件" : "，但没记录每个测试跑过哪些文件（coverage 开 dynamic_context 才有）"} <Tier t="T0" />
        </p>
      ) : (
        <p className="muted small">没有覆盖率数据，测试和源文件的对应只能按 import 推断（T1）。</p>
      )}
      {fails.length ? (
        <div className="small">
          <button className="link" onClick={() => setShowFails((v) => !v)}>{showFails ? "收起" : "展开"}失败的测试（{fails.length}）</button>
          {showFails ? fails.slice(0, 20).map((c) => (
            <div key={c.id} className="red">
              {c.file ? <button className="link" onClick={() => openEvidence({ path: c.file!, line: 1 })}>{c.id}</button> : c.id}
              {c.message ? <div className="muted">{c.message.slice(0, 160)}</div> : null}
            </div>
          )) : null}
        </div>
      ) : null}
      {t.problems.length ? <div className="amber small">{t.problems.join("；")}</div> : null}
    </div>
  );
}

/** 文件面板里的「测试与覆盖率」段。 */
export function FileTests({ ix, path }: { ix: SnapshotIndex; path: string }) {
  const t = ix.s.tests;
  const st = t?.fileStatus[path];
  if (!t?.run) return <dd className="muted">还没有测试结果</dd>;
  if (!st) return <dd className="muted">没有测试跑过它，也没有测试文件 import 它</dd>;
  const byId = new Map(t.run.cases.map((c) => [c.id, c]));
  const related = st.related.map((id) => byId.get(id)).filter((c): c is NonNullable<typeof c> => !!c);
  return (
    <dd>
      {st.coverage ? <div>覆盖率 {st.coverage.percent}%（测试跑到了 {st.coverage.covered} / {st.coverage.total} 行） <Tier t="T0" /></div> : null}
      {related.length ? (
        <div>
          相关测试 {related.length} 个：通过 {st.passed}、失败 {st.failed + st.errors}、跳过 {st.skipped} <Tier t={st.tier} />
          <span className="muted small"> {st.tier === "T0" ? "（覆盖率上下文或它本身就是测试文件）" : "（按 import 推断）"}</span>
          {related.slice(0, 30).map((c) => (
            <div key={c.id} className={c.status === "passed" ? "muted small" : c.status === "skipped" ? "muted small" : "red small"}>
              {c.status === "passed" ? "✓" : c.status === "skipped" ? "–" : "✗"} {c.id}
            </div>
          ))}
          {related.length > 30 ? <div className="muted small">… 另 {related.length - 30} 个</div> : null}
        </div>
      ) : (
        <div className="muted">没有相关测试</div>
      )}
    </dd>
  );
}
