import fs from "node:fs";
import path from "node:path";
import type { ActivityEvent, Touch } from "./types.ts";

/** Claude Code hook 的输入（只取我们关心的字段）。 */
export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  source?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  prompt?: string;
  [key: string]: unknown;
}

export interface HookOutcome {
  events: Omit<ActivityEvent, "id">[];
  touched: string[];
  /** 新会话开始：要记基线。 */
  sessionStart?: { session: string; source: string };
  ignored?: string;
}

function relativeInside(root: string, p: unknown): string | null {
  if (typeof p !== "string" || !p) return null;
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** 把一条 hook 输入翻译成活动事件与触碰路径。只认发生在本仓库里的。 */
export function hookToEvents(root: string, payload: HookPayload, now = new Date()): HookOutcome {
  const at = now.toISOString();
  const kind = payload.hook_event_name ?? "unknown";
  const session = typeof payload.session_id === "string" ? payload.session_id.slice(0, 8) : undefined;
  const cwdInside = payload.cwd === undefined || relativeInside(root, payload.cwd) !== null || path.resolve(String(payload.cwd)) === path.resolve(root);
  if (!cwdInside) return { events: [], touched: [], ignored: "cwd 不在仓库内" };
  const base = { at, source: "hook" as const, kind, ...(session ? { session } : {}) };
  if (kind === "SessionStart") {
    const source = typeof payload.source === "string" ? payload.source : "startup";
    return {
      events: [{ ...base, text: `会话 ${session ?? "?"} 开始（${source}）` }],
      touched: [],
      ...(source === "startup" || source === "clear" ? { sessionStart: { session: session ?? "unknown", source } } : {}),
    };
  }
  if (kind === "PostToolUse" || kind === "PreToolUse") {
    const tool = typeof payload.tool_name === "string" ? payload.tool_name : "?";
    const input = payload.tool_input ?? {};
    if (EDIT_TOOLS.has(tool)) {
      const rel = relativeInside(root, input["file_path"] ?? input["notebook_path"]);
      if (!rel) return { events: [], touched: [], ignored: "文件不在仓库内" };
      if (kind === "PreToolUse") return { events: [], touched: [] };
      return { events: [{ ...base, tool, path: rel, text: `${tool} ${rel}` }], touched: [rel] };
    }
    if (tool === "Bash" && kind === "PostToolUse") {
      const command = typeof input["command"] === "string" ? input["command"] : "";
      const short = command.replace(/\s+/g, " ").slice(0, 120);
      return { events: [{ ...base, tool, text: `Bash ${short}` }], touched: [] };
    }
    return { events: [], touched: [] };
  }
  if (kind === "UserPromptSubmit") {
    const prompt = typeof payload.prompt === "string" ? payload.prompt.replace(/\s+/g, " ").slice(0, 80) : "";
    return { events: [{ ...base, text: `提问：${prompt}` }], touched: [] };
  }
  if (kind === "Stop" || kind === "SessionEnd") {
    return { events: [{ ...base, text: kind === "Stop" ? `会话 ${session ?? "?"} 本轮结束` : `会话 ${session ?? "?"} 结束` }], touched: [] };
  }
  return { events: [], touched: [] };
}

/** 活动日志：内存里最近 N 条，追加写到 状态目录/events.jsonl。 */
export class ActivityLog {
  private events: ActivityEvent[] = [];
  private nextId = 1;
  private readonly file: string;
  private readonly touches = new Map<string, Touch>();
  readonly max: number;

  constructor(stateDir: string, max = 500) {
    this.max = max;
    fs.mkdirSync(stateDir, { recursive: true });
    this.file = path.join(stateDir, "events.jsonl");
    if (fs.existsSync(this.file)) {
      const lines = fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean).slice(-max);
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as ActivityEvent;
          this.events.push(ev);
          this.nextId = Math.max(this.nextId, ev.id + 1);
          if (ev.path && ev.source === "hook") this.touches.set(ev.path, { at: ev.at, ...(ev.session ? { session: ev.session } : {}), ...(ev.tool ? { tool: ev.tool } : {}) });
        } catch {
          /* 跳过坏行 */
        }
      }
    }
  }

  record(ev: Omit<ActivityEvent, "id">): ActivityEvent {
    const full: ActivityEvent = { id: this.nextId++, ...ev };
    this.events.push(full);
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
    if (full.path && full.source === "hook") this.touches.set(full.path, { at: full.at, ...(full.session ? { session: full.session } : {}), ...(full.tool ? { tool: full.tool } : {}) });
    try {
      fs.appendFileSync(this.file, JSON.stringify(full) + "\n", "utf8");
    } catch {
      /* 写不进去不影响运行 */
    }
    return full;
  }

  recent(limit = 100): ActivityEvent[] {
    return this.events.slice(-limit).reverse();
  }

  /** 最近 withinMs 内被 hook 触碰的文件。 */
  touched(withinMs = 30 * 60 * 1000, now = Date.now()): Record<string, Touch> {
    const out: Record<string, Touch> = {};
    for (const [p, t] of this.touches) {
      if (now - Date.parse(t.at) <= withinMs) out[p] = t;
    }
    return out;
  }
}
