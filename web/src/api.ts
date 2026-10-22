import type { Snapshot } from "../../src/snapshot.ts";

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
