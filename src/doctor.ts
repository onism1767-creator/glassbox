import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { parse } from "./parser.ts";

export async function doctor(): Promise<void> {
  const lines: string[] = [];
  lines.push(`node ${process.version}`);
  try {
    const db = new DatabaseSync(":memory:");
    db.exec("create table t(a)");
    lines.push("node:sqlite ok");
  } catch (error) {
    lines.push(`node:sqlite 不可用: ${String(error)}`);
  }
  try {
    lines.push(execFileSync("git", ["--version"], { encoding: "utf8" }).trim());
  } catch {
    lines.push("git 不可用");
  }
  for (const [grammar, sample] of [
    ["python", "import os\n"],
    ["typescript", "import x from './x'\n"],
  ] as const) {
    try {
      const tree = await parse(grammar, sample);
      lines.push(`tree-sitter ${grammar} ok (${tree?.rootNode.type})`);
    } catch (error) {
      lines.push(`tree-sitter ${grammar} 不可用: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  process.stdout.write(lines.join("\n") + "\n");
}
