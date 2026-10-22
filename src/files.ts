import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FileRecord } from "./types.ts";

const run = promisify(execFile);

/** 永远排除的目录名。 */
const EXCLUDED_DIRS = new Set([
  ".git", ".workbench", ".nativue", "node_modules", ".venv", "venv", "__pycache__",
  "dist", "build", ".next", "target", "vendor", "coverage", ".cache", ".mypy_cache",
  ".pytest_cache", ".ruff_cache", ".idea", ".vscode",
]);

/** 永远排除的敏感文件。 */
const SENSITIVE = /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx)|.*(?:credential|secret|token)s?\.json)$/i;

export const LANGUAGES: Record<string, string> = {
  ".py": "python", ".pyi": "python",
  ".ts": "typescript", ".tsx": "tsx", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".md": "markdown",
  ".html": "html", ".css": "css", ".sql": "sql", ".sh": "shell", ".txt": "text",
};

export const MAX_PARSE_BYTES = 1024 * 1024;

export async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run(
    "git",
    ["-c", "core.quotepath=off", "-c", "core.fsmonitor=false", "-C", root, ...args],
    { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
  );
  return stdout;
}

export function globToRegExp(pattern: string): RegExp {
  const p = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  const escaped = p
    .split("**")
    .map((part) => part.split("*").map((s) => s.replace(/[.+^${}()|[\]\\?]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp((p.includes("/") ? "^" : "(?:^|/)") + escaped + "(?:/|$)");
}

export function isExcluded(rel: string, extra: RegExp[]): boolean {
  if (rel.split("/").some((seg) => EXCLUDED_DIRS.has(seg))) return true;
  if (SENSITIVE.test(rel)) return true;
  return extra.some((rx) => rx.test(rel));
}

export async function listCandidates(root: string): Promise<{ files: string[]; viaGit: boolean }> {
  try {
    const out = await git(root, ["ls-files", "-c", "-o", "--exclude-standard", "-z"]);
    return { files: out.split("\0").filter(Boolean), viaGit: true };
  } catch {
    const files: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRS.has(entry.name)) await walk(full);
        } else if (entry.isFile()) files.push(rel);
      }
    }
    await walk(root);
    return { files: files.sort(), viaGit: false };
  }
}

export interface IndexedFiles {
  files: FileRecord[];
  contents: Map<string, string>;
  viaGit: boolean;
  skipped: string[];
}

export async function indexFiles(root: string, excludePatterns: string[] = []): Promise<IndexedFiles> {
  const extra = excludePatterns.map(globToRegExp);
  const { files: candidates, viaGit } = await listCandidates(root);
  const files: FileRecord[] = [];
  const contents = new Map<string, string>();
  const skipped: string[] = [];
  const base = await fs.realpath(root);
  for (const rel of [...new Set(candidates)].sort()) {
    if (path.isAbsolute(rel) || rel.split("/").includes("..") || isExcluded(rel, extra)) continue;
    const full = path.join(base, rel);
    let stat;
    try {
      stat = await fs.lstat(full);
    } catch {
      skipped.push(rel);
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const buffer = await fs.readFile(full);
    const binary = buffer.subarray(0, 8000).includes(0);
    const ext = path.extname(rel).toLowerCase();
    const language = binary ? "binary" : (LANGUAGES[ext] ?? "other");
    files.push({
      path: rel,
      dir: path.posix.dirname(rel),
      size: buffer.length,
      hash: createHash("sha256").update(buffer).digest("hex"),
      language,
      binary,
    });
    if (!binary && buffer.length <= MAX_PARSE_BYTES) contents.set(rel, buffer.toString("utf8"));
  }
  return { files, contents, viaGit, skipped };
}
