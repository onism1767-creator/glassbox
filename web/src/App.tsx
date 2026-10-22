import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, useReactFlow, useNodesInitialized, type Edge, type Node } from "@xyflow/react";
import { fetchSnapshot, subscribe, type UpdateMessage } from "./api.ts";
import { SnapshotIndex, buildGraph, type Level, type GNode, COLORS, basename, ago } from "./model.ts";
import { layoutGraph, type CanvasNode } from "./layout.ts";
import { nodeTypes } from "./nodes.tsx";
import { Panel } from "./Panel.tsx";
import type { ActivityEvent } from "../../src/types.ts";

function levelKey(level: Level): string {
  return level.kind === "dirs" ? "dirs" : level.kind === "files" ? `files:${level.dir}` : `symbols:${level.file}`;
}

function Breadcrumb({ level, onNavigate }: { level: Level; onNavigate: (l: Level) => void }) {
  const parts: { label: string; level: Level }[] = [{ label: "目录", level: { kind: "dirs" } }];
  if (level.kind === "files") parts.push({ label: level.dir === "." ? "根目录" : level.dir, level });
  if (level.kind === "symbols") {
    const dir = level.file.includes("/") ? level.file.slice(0, level.file.indexOf("/")) : ".";
    parts.push({ label: dir === "." ? "根目录" : dir, level: { kind: "files", dir } });
    parts.push({ label: basename(level.file), level });
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
      <div><i style={{ color: COLORS.violation }} /> 违规边</div>
      <div><i style={{ color: COLORS.allowed }} /> 白名单放行</div>
      <div><i style={{ color: COLORS.edge }} /> 普通 import</div>
      <div><i style={{ color: COLORS.change["A"] }} /> 自基线新增</div>
      <div><i style={{ color: COLORS.change["M"] }} /> 自基线修改</div>
      <div><i style={{ color: COLORS.call["import"] }} /> 调用：按 import</div>
      <div><i style={{ color: COLORS.call["same-file"] }} /> 调用：同文件</div>
      <div><i style={{ color: COLORS.call["self"] }} /> 调用：self 同类</div>
      <div><i style={{ color: COLORS.call["pyright"], borderStyle: "dashed" }} /> 调用：pyright 推断</div>
    </div>
  );
}

function sourceText(e: ActivityEvent): string {
  return e.source === "hook" ? "Claude" : e.source === "watcher" ? "监听" : e.source === "git" ? "git" : "系统";
}

function Activity({ events, onClose }: { events: ActivityEvent[]; onClose: () => void }) {
  return (
    <div className="activity">
      <div className="activity-head">
        <span>活动流（最近 {events.length} 条）</span>
        <button className="link" onClick={onClose}>收起</button>
      </div>
      <div className="activity-list">
        {events.length ? events.map((e) => (
          <div key={e.id} className={`activity-row ${e.source}`}>
            <span className="t">{e.at.slice(11, 19)}</span>
            <span className="src">{sourceText(e)}</span>
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
}

function Canvas({ ix, live, events, onToggleActivity, showActivity }: { ix: SnapshotIndex; live: Live; events: ActivityEvent[]; onToggleActivity: () => void; showActivity: boolean }) {
  const [level, setLevel] = useState<Level>({ kind: "dirs" });
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
      setSelectedId(selectedStillThere ? want : null);
      if (levelChanged) {
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

  const selected = useMemo((): GNode | null => {
    const n = nodes.find((x) => x.id === selectedId);
    return n && n.type !== "lane" ? (n as Node<{ g: GNode }>).data.g : null;
  }, [nodes, selectedId]);

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

  const stageText = ix.s.history.latestStage ? `代码到达 ${ix.s.history.latestStage}` : "";
  const baseline = ix.s.baseline;
  void tick;
  const updatedText = live.last ? `更新于 ${ago(live.last.at)}（${(live.last.elapsedMs / 1000).toFixed(1)} 秒）` : `快照 ${ago(ix.s.generatedAt)}`;
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">glassbox</div>
        <Breadcrumb level={level} onNavigate={(l) => navigate(l)} />
        <div className="meta">
          <span className={`live ${live.connected ? "on" : "off"}`} title={live.connected ? "已连接实时推送" : "未连接实时推送"}>
            {live.connected ? "● 实时" : "○ 离线"} · {live.refreshing ? "刷新中…" : updatedText}
          </span>
          <span>{ix.s.source.commit?.slice(0, 9) ?? "无 git"}{ix.s.source.branch ? ` · ${ix.s.source.branch}` : ""}{ix.s.source.dirty ? " · 工作区有改动" : ""}</span>
          {stageText ? <span>{stageText}</span> : null}
          {baseline ? <span>基线后 {baseline.commitsSince} 提交 · {baseline.changes.length} 文件变更</span> : <span>无基线</span>}
          <span className={ix.s.violations.length ? "red" : "green"}>违规 {ix.s.violations.length}</span>
          <button className="crumb" onClick={onToggleActivity}>活动 {events.length}</button>
        </div>
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            onSearch();
          }}
        >
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="文件名或函数名，回车跳转" />
        </form>
      </header>
      <div className="body">
        <div className="canvas">
          <ReactFlow
            key={mountId}
            fitView
            fitViewOptions={{ padding: 0.12 }}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            minZoom={0.1}
            maxZoom={2.5}
            nodesConnectable={false}
            elementsSelectable
            onNodeClick={(_, n) => {
              setSelectedId(n.id);
            }}
            onNodeDoubleClick={(_, n) => {
              const g = (n as Node<{ g?: GNode }>).data.g;
              if (g?.drill) navigate(g.drill);
              else if (g?.ref.kind === "portal") navigate(g.ref.target);
            }}
            onPaneClick={() => setSelectedId(null)}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} color="#e3e6ea" />
            <MiniMap pannable zoomable nodeColor={(n) => (n.type === "lane" ? "transparent" : "#b8c0cc")} />
            <Controls showInteractive={false} />
          </ReactFlow>
          <Legend />
          {showActivity ? <Activity events={events} onClose={onToggleActivity} /> : null}
        </div>
        <Panel ix={ix} selected={selected} onNavigate={navigate} />
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
          setLive((l) => ({ ...l, refreshing: false }));
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
  if (!ix) return <div className="center muted">读取快照…</div>;
  return (
    <ReactFlowProvider>
      <Canvas ix={ix} live={live} events={events} showActivity={showActivity} onToggleActivity={() => setShowActivity((v) => !v)} />
    </ReactFlowProvider>
  );
}
