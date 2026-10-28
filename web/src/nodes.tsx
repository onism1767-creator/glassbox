import { Handle, Position, useStore, type NodeProps, type Node } from "@xyflow/react";
import type { GNode, Lane } from "./model.ts";
import { COLORS } from "./model.ts";

type GProps = NodeProps<Node<{ g: GNode; hit?: boolean; focus?: boolean }>>;

function useDetail(): boolean {
  return useStore((s) => s.transform[2] >= 0.55);
}

function Badges({ g }: { g: GNode }) {
  if (!g.badges.length) return null;
  return (
    <div className="badges">
      {g.badges.map((b, i) => (
        <span key={i} className={`badge ${b.tone}`}>
          {b.text}
        </span>
      ))}
    </div>
  );
}

function Box({ g, selected, className, hit, focus }: { g: GNode; selected: boolean; className: string; hit?: boolean; focus?: boolean }) {
  const detail = useDetail();
  const changeColor = g.change && g.change !== "clean" ? COLORS.change[g.change] : undefined;
  return (
    <div
      className={`gnode ${className}${selected ? " selected" : ""}${g.drill ? " drillable" : ""}${hit ? " hit" : ""}${focus ? " focus" : ""}`}
      style={changeColor ? { boxShadow: `inset 5px 0 0 ${changeColor}` } : undefined}
      title={g.drill ? "双击下钻" : undefined}
    >
      <Handle type="target" position={Position.Left} />
      <div className="label">{g.label}</div>
      {detail && g.sub ? <div className="sub">{g.sub}</div> : null}
      {detail ? <Badges g={g} /> : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function DirNode({ data, selected }: GProps) {
  return <Box g={data.g} selected={!!selected} hit={data.hit} focus={data.focus} className={`dir${data.g.layer !== undefined ? ` l${data.g.layer}` : ""}`} />;
}
export function FileNode({ data, selected }: GProps) {
  return <Box g={data.g} selected={!!selected} hit={data.hit} focus={data.focus} className="file" />;
}
export function SymbolNode({ data, selected }: GProps) {
  return <Box g={data.g} selected={!!selected} hit={data.hit} focus={data.focus} className="symbol" />;
}
export function PortalNode({ data, selected }: GProps) {
  return <Box g={data.g} selected={!!selected} hit={data.hit} focus={data.focus} className="portal" />;
}
export function LaneNode({ data }: NodeProps<Node<{ lane: Lane }>>) {
  return (
    <div className={`lane ${data.lane.tone}`}>
      <div className="lane-label">{data.lane.label}</div>
    </div>
  );
}

export const nodeTypes = { dir: DirNode, file: FileNode, symbol: SymbolNode, portal: PortalNode, lane: LaneNode };
