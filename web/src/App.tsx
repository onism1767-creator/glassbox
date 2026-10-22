import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, useReactFlow, useNodesInitialized, type Edge, type Node } from "@xyflow/react";
import { fetchSnapshot } from "./api.ts";
import { SnapshotIndex, buildGraph, type Level, type GNode, COLORS, basename } from "./model.ts";
import { layoutGraph, type CanvasNode } from "./layout.ts";
import { nodeTypes } from "./nodes.tsx";
import { Panel } from "./Panel.tsx";

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
      <div><i style={{ background: COLORS.violation }} /> 违规边</div>
      <div><i style={{ background: COLORS.allowed }} /> 白名单放行</div>
      <div><i style={{ background: COLORS.edge }} /> 普通 import</div>
      <div><i style={{ background: COLORS.change["A"] }} /> 自基线新增</div>
      <div><i style={{ background: COLORS.change["M"] }} /> 自基线修改</div>
      <div><i style={{ background: COLORS.call["import"] }} /> 调用：按 import</div>
      <div><i style={{ background: COLORS.call["same-file"] }} /> 调用：同文件</div>
      <div><i style={{ background: COLORS.call["self"] }} /> 调用：self 同类</div>
      <div><i style={{ background: COLORS.call["pyright"], borderStyle: "dashed" }} /> 调用：pyright 推断</div>
    </div>
  );
}

function Canvas({ ix }: { ix: SnapshotIndex }) {
  const [level, setLevel] = useState<Level>({ kind: "dirs" });
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [layoutId, setLayoutId] = useState(0);
  const pendingSelect = useRef<string | null>(null);
  const focusAfterLayout = useRef<string | null>(null);
  const { fitView } = useReactFlow();
  const initialized = useNodesInitialized();

  useEffect(() => {
    let cancelled = false;
    const graph = buildGraph(ix, level);
    layoutGraph(graph).then(({ nodes: n, edges: e }) => {
      if (cancelled) return;
      const want = pendingSelect.current;
      pendingSelect.current = null;
      focusAfterLayout.current = want;
      setNodes(want ? n.map((x) => (x.id === want ? { ...x, selected: true } : x)) : n);
      setEdges(e);
      setSelectedId(want);
      setLayoutId((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [ix, level]);

  useEffect(() => {
    if (!layoutId || !initialized) return;
    const want = focusAfterLayout.current;
    if (!want) return;
    const timer = setTimeout(() => fitView({ nodes: [{ id: want }], maxZoom: 1.2, padding: 1.5, duration: 250 }), 60);
    return () => clearTimeout(timer);
  }, [layoutId, initialized, fitView]);

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
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">glassbox</div>
        <Breadcrumb level={level} onNavigate={(l) => navigate(l)} />
        <div className="meta">
          <span>{ix.s.source.commit?.slice(0, 9) ?? "无 git"}{ix.s.source.branch ? ` · ${ix.s.source.branch}` : ""}{ix.s.source.dirty ? " · 工作区有改动" : ""}</span>
          {stageText ? <span>{stageText}</span> : null}
          {baseline ? <span>基线后 {baseline.commitsSince} 提交 · {baseline.changes.length} 文件变更</span> : <span>无基线</span>}
          <span className={ix.s.violations.length ? "red" : "green"}>违规 {ix.s.violations.length}</span>
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
            key={layoutId}
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
        </div>
        <Panel ix={ix} selected={selected} onNavigate={navigate} />
      </div>
    </div>
  );
}

export function App() {
  const [ix, setIx] = useState<SnapshotIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchSnapshot()
      .then((s) => setIx(new SnapshotIndex(s)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  if (error) return <div className="center red">{error}</div>;
  if (!ix) return <div className="center muted">读取快照…</div>;
  return (
    <ReactFlowProvider>
      <Canvas ix={ix} />
    </ReactFlowProvider>
  );
}
