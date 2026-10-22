import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hookScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "glassbox-hook.js").split(path.sep).join("/");

interface HookEntry {
  type: "command";
  command: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
type HooksConfig = Record<string, HookGroup[]>;

export function hookCommand(port: number): string {
  return `node "${hookScript}" --port ${port}`;
}

/** 要装进 .claude/settings.json 的 hooks。 */
export function hooksConfig(port: number): HooksConfig {
  const entry: HookEntry = { type: "command", command: hookCommand(port), timeout: 5 };
  return {
    SessionStart: [{ hooks: [entry] }],
    PostToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash", hooks: [entry] }],
    Stop: [{ hooks: [entry] }],
  };
}

const MARK = "glassbox-hook.js";

/** 合并进目标仓库的 .claude/settings.json：先去掉旧的 glassbox 条目，再加新的；别的配置原样保留。 */
export function installHooks(repoRoot: string, port: number): { file: string; created: boolean } {
  const dir = path.join(repoRoot, ".claude");
  const file = path.join(dir, "settings.json");
  fs.mkdirSync(dir, { recursive: true });
  let settings: Record<string, unknown> = {};
  let created = true;
  if (fs.existsSync(file)) {
    created = false;
    const raw = fs.readFileSync(file, "utf8");
    if (raw.trim()) settings = JSON.parse(raw) as Record<string, unknown>;
  }
  const existing = (settings["hooks"] ?? {}) as HooksConfig;
  const next: HooksConfig = {};
  for (const [event, groups] of Object.entries(existing)) {
    const kept = (groups ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !h.command?.includes(MARK)) }))
      .filter((g) => g.hooks.length);
    if (kept.length) next[event] = kept;
  }
  for (const [event, groups] of Object.entries(hooksConfig(port))) next[event] = [...(next[event] ?? []), ...groups];
  settings["hooks"] = next;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return { file, created };
}
