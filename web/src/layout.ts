import ELK, { type ElkNode, type ElkExtendedEdge } from "elkjs/lib/elk.bundled.js";
import type { Node, Edge } from "@xyflow/react";
import { MarkerType } from "@xyflow/react";
import type { Graph, GNode, Lane } from "./model.ts";

const elk = new ELK();

export interface LaneBox {
  lane: Lane;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CanvasNode = Node<{ g: GNode }, "dir" | "file" | "symbol" | "portal"> | Node<{ lane: Lane }, "lane">;

export async function layoutGraph(graph: Graph): Promise<{ nodes: CanvasNode[]; edges: Edge[] }> {
  const partitioned = graph.lanes.length > 1;
  const elkGraph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "90",
      "elk.spacing.nodeNode": "28",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.semiInteractive": "true",
      "elk.separateConnectedComponents": "false",
      ...(partitioned ? { "elk.partitioning.activate": "true" } : {}),
    },
    children: graph.nodes.map((n) => ({
      id: n.id,
      width: n.width,
      height: n.height,
      ...(partitioned ? { layoutOptions: { "elk.partitioning.partition": String(n.partition) } } : {}),
    })),
    edges: graph.edges.map<ElkExtendedEdge>((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const result = await elk.layout(elkGraph);
  const positions = new Map<string, { x: number; y: number }>();
  for (const c of result.children ?? []) positions.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });

  const byPartition = new Map<number, GNode[]>();
  for (const n of graph.nodes) byPartition.set(n.partition, [...(byPartition.get(n.partition) ?? []), n]);
  const laneNodes: CanvasNode[] = [];
  const pad = 28;
  const allY = graph.nodes.map((n) => positions.get(n.id)?.y ?? 0);
  const allBottom = graph.nodes.map((n) => (positions.get(n.id)?.y ?? 0) + n.height);
  const top = Math.min(...allY, 0) - pad - 24;
  const bottom = Math.max(...allBottom, 0) + pad;
  for (const lane of graph.lanes) {
    const members = byPartition.get(lane.partition) ?? [];
    if (!members.length) continue;
    const xs = members.map((n) => positions.get(n.id)?.x ?? 0);
    const rights = members.map((n) => (positions.get(n.id)?.x ?? 0) + n.width);
    const x = Math.min(...xs) - pad;
    const width = Math.max(...rights) - Math.min(...xs) + pad * 2;
    laneNodes.push({
      id: `lane:${lane.partition}`,
      type: "lane",
      position: { x, y: top },
      data: { lane },
      width,
      height: bottom - top,
      style: { width, height: bottom - top },
      draggable: false,
      selectable: false,
      zIndex: -1,
    });
  }
  const nodes: CanvasNode[] = [
    ...laneNodes,
    ...graph.nodes.map<CanvasNode>((n) => ({
      id: n.id,
      type: n.type,
      position: positions.get(n.id) ?? { x: 0, y: 0 },
      data: { g: n },
      width: n.width,
      height: n.height,
      style: { width: n.width, height: n.height },
    })),
  ];
  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: "default",
    label: e.label,
    labelStyle: { fontSize: 10, fill: e.color },
    labelBgStyle: { fill: "#fff", fillOpacity: 0.85 },
    style: { stroke: e.color, strokeWidth: e.width, ...(e.dashed ? { strokeDasharray: "6 4" } : {}) },
    markerEnd: { type: MarkerType.ArrowClosed, color: e.color, width: 14, height: 14 },
  }));
  return { nodes, edges };
}
