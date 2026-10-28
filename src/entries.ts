/**
 * 入口候选（T0）：路由、CLI 子命令、main 函数、`if __name__ == "__main__"`。
 * 旅程从入口开始，这份清单帮人或 AI 挑起点；只是正则扫源码，不解析框架。
 */

export interface EntryPoint {
  path: string;
  line: number;
  kind: "route" | "command" | "main" | "cli";
  /** 给人看的一句：GET /diagnose、命令 calibrate、main()。 */
  text: string;
  /** 紧跟在装饰器后面的函数名（有就记）。 */
  symbol?: string;
}

const PY_ROUTE = /^\s*@(\w+)\.(get|post|put|patch|delete|route|api_route|websocket)\(\s*["']([^"']*)["']/;
const PY_COMMAND = /^\s*@(\w+)\.command\(/;
const PY_MAIN_GUARD = /^\s*if\s+__name__\s*==\s*["']__main__["']\s*:/;
const PY_MAIN_DEF = /^(?:async\s+)?def\s+main\s*\(/;
const PY_DEF = /^\s*(?:async\s+)?def\s+(\w+)\s*\(/;
const JS_ROUTE = /\b(app|router|server|fastify)\.(get|post|put|patch|delete|use|all)\(\s*["'`]([^"'`]+)["'`]/;

function nextDef(lines: string[], from: number, limit = 6): string | undefined {
  for (let i = from; i < Math.min(lines.length, from + limit); i++) {
    const m = PY_DEF.exec(lines[i] ?? "");
    if (m) return m[1];
  }
  return undefined;
}

export function extractEntryPoints(path: string, content: string, language: string): EntryPoint[] {
  const out: EntryPoint[] = [];
  const lines = content.split("\n");
  if (language === "python") {
    lines.forEach((line, i) => {
      const r = PY_ROUTE.exec(line);
      if (r) {
        const method = r[2] === "route" || r[2] === "api_route" ? "ROUTE" : r[2] === "websocket" ? "WS" : r[2]!.toUpperCase();
        const sym = nextDef(lines, i + 1);
        out.push({ path, line: i + 1, kind: "route", text: `${method} ${r[3]}`, ...(sym ? { symbol: sym } : {}) });
        return;
      }
      if (PY_COMMAND.test(line)) {
        const sym = nextDef(lines, i + 1);
        out.push({ path, line: i + 1, kind: "command", text: `命令 ${sym ?? "?"}`, ...(sym ? { symbol: sym } : {}) });
        return;
      }
      if (PY_MAIN_GUARD.test(line)) out.push({ path, line: i + 1, kind: "main", text: "直接运行这个文件（__main__）" });
      else if (PY_MAIN_DEF.test(line)) out.push({ path, line: i + 1, kind: "cli", text: "main()", symbol: "main" });
    });
  } else if (language === "javascript" || language === "typescript" || language === "tsx") {
    lines.forEach((line, i) => {
      const r = JS_ROUTE.exec(line);
      if (r) out.push({ path, line: i + 1, kind: "route", text: `${r[2] === "use" || r[2] === "all" ? "ROUTE" : r[2]!.toUpperCase()} ${r[3]}` });
    });
  }
  return out;
}
