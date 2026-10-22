import type { Snapshot } from "../../src/snapshot.ts";
import type { ActivityEvent } from "../../src/types.ts";

export async function fetchSnapshot(): Promise<Snapshot> {
  const res = await fetch("/api/snapshot");
  if (!res.ok) throw new Error(`读取快照失败：${res.status} ${await res.text()}`);
  return (await res.json()) as Snapshot;
}

export interface SourceExcerpt {
  path: string;
  from: number;
  lines: string[];
}

export async function fetchSource(path: string, line: number, context = 4): Promise<SourceExcerpt> {
  const res = await fetch(`/api/file?path=${encodeURIComponent(path)}&line=${line}&context=${context}`);
  if (!res.ok) throw new Error(`读取源码失败：${res.status}`);
  return (await res.json()) as SourceExcerpt;
}

export interface UpdateMessage {
  at: string;
  reason: "initial" | "files" | "git" | "hook" | "manual";
  changed: string[];
  elapsedMs: number;
  violations: number;
  files: number;
}

export interface StreamHandlers {
  onUpdate: (m: UpdateMessage) => void;
  onActivity: (e: ActivityEvent) => void;
  onState: (connected: boolean) => void;
}

/** 订阅服务端推送；返回取消函数。 */
export function subscribe(handlers: StreamHandlers): () => void {
  const es = new EventSource("/api/stream");
  es.addEventListener("update", (e) => handlers.onUpdate(JSON.parse((e as MessageEvent<string>).data) as UpdateMessage));
  es.addEventListener("activity", (e) => handlers.onActivity(JSON.parse((e as MessageEvent<string>).data) as ActivityEvent));
  es.onopen = () => handlers.onState(true);
  es.onerror = () => handlers.onState(false);
  return () => es.close();
}
