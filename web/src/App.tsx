import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, useReactFlow, useNodesInitialized, type Edge, type Node } from "@xyflow/react";
import { fetchSnapshot, subscribe, type UpdateMessage } from "./api.ts";
import { SnapshotIndex, buildGraph, type Level, type GNode, type GEdge, COLORS, basename, ago } from "./model.ts";
import { layoutGraph, type CanvasNode } from "./layout.ts";
import { nodeTypes } from "./nodes.tsx";
import { Panel, type Selection } from "./Panel.tsx";
import { Tasks } from "./Tasks.tsx";
import { testSummaryText } from "./TestsSection.tsx";
import { WORDS, sourceShort, dirShort } from "./words.ts";
import type { ActivityEvent } from "../../src/types.ts";
import type { AutoTestState } from "../../src/tests.ts";

function levelKey(level: Level): string {
  return level.kind === "dirs" ? "dirs" : level.kind === "files" ? `files:${level.dir}` : `symbols:${level.file}`;
}

function Breadcrumb({ ix, level, onNavigate }: { ix: SnapshotIndex; level: Level; onNavigate: (l: Level) => void }) {
  const parts: { label: string; level: Level }[] = [{ label: "整个项目（目录级）", level: { kind: "dirs" } }];
  if (level.kind === "files") parts.push({ label: `${dirShort(level.dir, ix.names)} 里的文件`, level });
  if (level.kind === "symbols") {
    const dir = level.file.includes("/") ? level.file.slice(0, level.file.indexOf("/")) : ".";
    parts.push({ label: `${dirShort(dir, ix.names)} 里的文件`, level: { kind: "files", dir } });
    parts.push({ label: `${basename(level.file)} 里的函数`, level });
  }
  return (
    <nav className="crumbs">
      {parts.map((p, i) => (
        <span key={i}>
          {i ? <span className="sep">›</span> : null}
          <button className={i === parts.length - 1 ? "crumb current" : "crumb"} onClick={() => onNavigate(p.level)}>
            {p.label}
          </button>
        </span>
      ))}
    </nav>
  );
}

function Legend() {
  return (
    <div className="legend">
      <div><i style={{ color: COLORS.violation }} /> 越层调用的线（分层违规）</div>
      <div><i style={{ color: COLORS.allowed }} /> 明文允许的例外（白名单放行）</div>
      <div><i style={{ color: COLORS.edge }} /> 普通的 import 线</div>
      <div><i style={{ color: COLORS.change["A"] }} /> 这次会话新增的文件（相对基线）</div>
      <div><i style={{ color: COLORS.change["M"] }} /> 这次会话修改的文件（相对基线）</div>
      <div><i style={{ color: COLORS.call["import"] }} /> 调用线：顺着 import 找到（import）</div>
      <div><i style={{ color: COLORS.call["same-file"] }} /> 调用线：同一个文件里（same-file）</div>
      <div><i style={{ color: COLORS.call["self"] }} /> 调用线：自己类里的方法（self）</div>
      <div><i style={{ color: COLORS.call["pyright"], borderStyle: "dashed" }} /> 调用线：类型分析器推断（pyright）</div>
      <div className="legend-note">线越粗，import 或调用的次数越多；箭头从"用的人"指向"被用的人"。点一条线能看到对应的代码行。</div>
    </div>
  );
}

function Activity({ events, onClose }: { events: ActivityEvent[]; onClose: () => void }) {
  return (
    <div className="activity">
      <div className="activity-head">
        <span>刚发生了什么（活动流，最近 {events.length} 条）</span>
        <button className="link" onClick={onClose}>收起</button>
      </div>
      <div className="activity-list">
        {events.length ? events.map((e) => (
          <div key={e.id} className={`activity-row ${e.source}`}>
            <span className="t">{e.at.slice(11, 19)}</span>
            <span className="src">{sourceShort(e.source)}</span>
            {e.session ? <span className="sess">{e.session}</span> : null}
            <span className="txt">{e.text}</span>
          </div>
        )) : <div className="muted">还没有事件。改一个文件、提交一次，或装上 hooks 让 Claude 的动作出现在这里。</div>}
      </div>
    </div>
  );
}

interface Live {
  connected: boolean;
  last?: UpdateMessage;
  refreshing: boolean;
  /** 正在自动跑的相关测试。 */
  testing?: AutoTestState["running"];
}

function Canvas({ ix, live, events, onToggleActivity, showActivity }: { ix: SnapshotIndex; live: Live; events: ActivityEvent[]; onToggleActivity: () => void; showActivity: boolean }) {
  const [level, setLevel] = useState<Level>({ kind: "dirs" });
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [gEdges, setGEdges] = useState<Map<string, GEdge>>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showTasks, setShowTasks] = useState<boolean>(() => !!ix.s.tasks);
  const [query, setQuery] = useState("");
  const [mountId, setMountId] = useState(0);
  const [tick, setTick] = useState(0);
  const pendingSelect = useRef<string | null>(null);
  const focusAfterLayout = useRef<string | null>(null);
  const lastLevel = useRef<string>("");
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const { fitView } = useReactFlow();
  const initialized = useNodesInitialized();

  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const key = levelKey(level);
    const levelChanged = lastLevel.current !== key;
    const graph = buildGraph(ix, level);
    layoutGraph(graph).then(({ nodes: n, edges: e }) => {
      if (cancelled) return;
      const want = pendingSelect.current ?? (levelChanged ? null : selectedRef.current);
      pendingSelect.current = null;
      const selectedStillThere = want && n.some((x) => x.id === want);
      setNodes(selectedStillThere ? n.map((x) => (x.id === want ? { ...x, selected: true } : x)) : n);
      setEdges(e);
      setGEdges(new Map(graph.edges.map((ge) => [ge.id, ge])));
      setSelectedId(selectedStillThere ? want : null);
      if (levelChanged) {
        setSelectedEdgeId(null);
        lastLevel.current = key;
        focusAfterLayout.current = selectedStillThere ? want : null;
        setMountId((v) => v + 1);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ix, level]);

  useEffect(() => {
    if (!mountId || !initialized) return;
    const want = focusAfterLayout.current;
    if (!want) return;
    focusAfterLayout.current = null;
    const timer = setTimeout(() => fitView({ nodes: [{ id: want }], maxZoom: 1.2, padding: 1.5, duration: 250 }), 60);
    return () => clearTimeout(timer);
  }, [mountId, initialized, fitView]);

  const navigate = useCallback((l: Level, select?: string) => {
    pendingSelect.current = select ?? null;
    setLevel(l);
  }, []);

  const selection = useMemo((): Selection | null => {
    if (selectedTaskId) return { kind: "task", id: selectedTaskId };
    if (selectedEdgeId) {
      const ge = gEdges.get(selectedEdgeId);
      if (ge) return { kind: "edge", e: ge };
    }
    const n = nodes.find((x) => x.id === selectedId);
    return n && n.type !== "lane" ? { kind: "node", g: (n as Node<{ g: GNode }>).data.g } : null;
  }, [nodes, selectedId, selectedEdgeId, selectedTaskId, gEdges]);

  /** 选中任务时，它提到的文件在画布上高亮。 */
  const hitFiles = useMemo(() => {
    const t = selectedTaskId ? ix.s.tasks?.items.find((x) => x.id === selectedTaskId) : undefined;
    return new Set(t?.files ?? []);
  }, [ix, selectedTaskId]);
  const nodesWithHit = useMemo(() => {
    if (!hitFiles.size) return nodes;
    return nodes.map((n) => {
      if (n.type === "lane") return n;
      const g = (n as Node<{ g: GNode }>).data.g;
      const hit = g.files.some((f) => hitFiles.has(f));
      return hit ? ({ ...n, data: { ...n.data, hit: true } } as CanvasNode) : n;
    });
  }, [nodes, hitFiles]);

  const onSearch = (): void => {
    const q = query.trim();
    if (!q) return;
    const file = [...ix.files.keys()].find((p) => p === q || p.endsWith("/" + q) || basename(p) === q);
    if (file) {
      const dir = file.includes("/") ? file.slice(0, file.indexOf("/")) : ".";
      navigate({ kind: "files", dir }, `file:${file}`);
      return;
    }
    const sym = ix.s.symbols.find((s) => s.qualified === q || s.name === q || s.id === q);
    if (sym) navigate({ kind: "symbols", file: sym.path }, `sym:${sym.id}`);
  };

  const baseline = ix.s.baseline;
  void tick;
  const updatedText = live.last ? `${ago(live.last.at)}更新，这次算了 ${(live.last.elapsedMs / 1000).toFixed(1)} 秒` : `图是 ${ago(ix.s.generatedAt)}算的`;
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">glassbox</div>
        <Breadcrumb ix={ix} level={level} onNavigate={(l) => navigate(l)} />
        <div className="meta">
          <span className={`live ${live.connected ? "on" : "off"}`}>
            {live.connected ? WORDS.liveOn : WORDS.liveOff} · {live.refreshing ? "正在重算…" : updatedText}
          </span>
          <span title="当前代码版本（git 提交）与分支">
            {ix.s.source.commit ? `代码版本 ${ix.s.source.commit.slice(0, 9)}（git 提交）` : "没有 git"}{ix.s.source.branch ? ` · 分支 ${ix.s.source.branch}` : ""}{ix.s.source.dirty ? " · 有还没提交的改动" : ""}
          </span>
          {ix.s.history.latestStage ? <span>{WORDS.stage(ix.s.history.latestStage)}</span> : null}
          <span>{baseline ? WORDS.baseline(baseline.commitsSince, baseline.changes.length) : WORDS.noBaseline}</span>
          <span className={ix.s.violations.length ? "red" : "green"}>{WORDS.violations(ix.s.violations.length)}</span>
          {(() => {
            const t = testSummaryText(ix);
            return <span className={t.bad ? "red" : ix.s.tests?.run ? "green" : ""}>{t.text}</span>;
          })()}
          {live.testing ? (
            <span className="purple" title={`改了 ${live.testing.changed.join("、")}`}>
              正在跑{live.testing.estimated ? `约 ${live.testing.estimated} 个` : ""}相关测试（改了 {live.testing.changed.slice(0, 2).map(basename).join("、")}{live.testing.changed.length > 2 ? "…" : ""}）…
            </span>
          ) : null}
          <button className="crumb" onClick={() => setShowTasks((v) => !v)}>{showTasks ? "收起任务栏" : `任务与进度${ix.s.tasks ? `（${ix.s.tasks.items.length}）` : ""}`}</button>
          <button className="crumb" onClick={onToggleActivity}>刚发生了什么 {events.length}（活动流）</button>
        </div>
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            onSearch();
          }}
        >
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="输文件名或函数名，回车跳过去" />
        </form>
      </header>
      <div className="body">
        {showTasks ? <Tasks ix={ix} selectedTaskId={selectedTaskId} onSelect={(id) => { setSelectedTaskId(id); if (id) { setSelectedId(null); setSelectedEdgeId(null); } }} onClose={() => setShowTasks(false)} /> : null}
        <div className="canvas">
          <ReactFlow
            key={mountId}
            fitView
            fitViewOptions={{ padding: 0.12 }}
            nodes={nodesWithHit}
            edges={edges}
            nodeTypes={nodeTypes}
            minZoom={0.1}
            maxZoom={2.5}
            nodesConnectable={false}
            elementsSelectable
            onNodeClick={(_, n) => {
              setSelectedEdgeId(null);
              setSelectedTaskId(null);
              setSelectedId(n.id);
            }}
            onEdgeClick={(_, e) => {
              setSelectedId(null);
              setSelectedTaskId(null);
              setSelectedEdgeId(e.id);
            }}
            onNodeDoubleClick={(_, n) => {
              const g = (n as Node<{ g?: GNode }>).data.g;
              if (g?.drill) navigate(g.drill);
              else if (g?.ref.kind === "portal") navigate(g.ref.target);
            }}
            onPaneClick={() => {
              setSelectedId(null);
              setSelectedEdgeId(null);
              setSelectedTaskId(null);
            }}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} color="#e3e6ea" />
            <MiniMap pannable zoomable nodeColor={(n) => (n.type === "lane" ? "transparent" : "#b8c0cc")} />
            <Controls showInteractive={false} />
          </ReactFlow>
          <Legend />
          {showActivity ? <Activity events={events} onClose={onToggleActivity} /> : null}
        </div>
        <Panel ix={ix} selection={selection} onNavigate={navigate} />
      </div>
    </div>
  );
}

export function App() {
  const [ix, setIx] = useState<SnapshotIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Live>({ connected: false, refreshing: false });
  const [liveEvents, setLiveEvents] = useState<ActivityEvent[]>([]);
  const [showActivity, setShowActivity] = useState(false);

  useEffect(() => {
    let disposed = false;
    const load = (): void => {
      fetchSnapshot()
        .then((s) => {
          if (disposed) return;
          setIx(new SnapshotIndex(s));
          // 快照里带着自动跑的当前状态；SSE 断线期间跑完的，靠这里把顶栏的「正在跑」清掉。
          setLive((l) => ({ ...l, refreshing: false, testing: s.tests?.auto?.running }));
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    };
    load();
    const unsubscribe = subscribe({
      onUpdate: (m) => {
        setLive((l) => ({ ...l, last: m, refreshing: true }));
        load();
      },
      onActivity: (e) => setLiveEvents((list) => [e, ...list].slice(0, 200)),
      onAutotest: (s) => setLive((l) => ({ ...l, testing: s.running })),
      onState: (connected) => setLive((l) => ({ ...l, connected })),
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const events = useMemo(() => {
    const fromSnapshot = ix?.s.activity?.events ?? [];
    const seen = new Set(fromSnapshot.map((e) => e.id));
    return [...liveEvents.filter((e) => !seen.has(e.id)), ...fromSnapshot].sort((a, b) => b.id - a.id).slice(0, 200);
  }, [ix, liveEvents]);

  if (error) return <div className="center red">{error}</div>;
  if (!ix) return <div className="center muted">正在读取这个项目的图…</div>;
  return (
    <ReactFlowProvider>
      <Canvas ix={ix} live={live} events={events} showActivity={showActivity} onToggleActivity={() => setShowActivity((v) => !v)} />
    </ReactFlowProvider>
  );
}
