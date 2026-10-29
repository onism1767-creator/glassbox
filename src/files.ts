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
  ".pytest_cache", ".ruff_cache", ".idea", ".vscode", ".pgdata", ".hypothesis", ".tox", ".nox", ".eggs",
]);

/** 以点开头的目录里只有这几个是"源码或配置"，其余（数据库数据、缓存、工具状态）一律不看也不监听。 */
const DOT_DIRS_KEPT = new Set([".claude", ".github", ".gitlab", ".circleci", ".devcontainer", ".husky", ".storybook"]);

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

const NO_EXTRA_DOT_DIRS: ReadonlySet<string> = new Set();

/**
 * @param extra overlay 的 exclude 规则
 * @param keepDotDirs overlay 的 keep_dot_dirs：以点开头但要看的目录名（固定排除名单优先）
 */
export function isExcluded(rel: string, extra: RegExp[], keepDotDirs: ReadonlySet<string> = NO_EXTRA_DOT_DIRS): boolean {
  const segs = rel.split("/");
  if (segs.some((seg) => EXCLUDED_DIRS.has(seg))) return true;
  // 目录段（最后一段是文件名，不算）以点开头且不在保留名单里：排除。
  if (segs.slice(0, -1).some((seg) => seg.startsWith(".") && !DOT_DIRS_KEPT.has(seg) && !keepDotDirs.has(seg))) return true;
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

/**
 * 文件内容哈希，换行符统一成 \n 再算（E-040）：被观测仓库开着 core.autocrlf 时，同一份内容在工作区里
 * 一会儿 CRLF 一会儿 LF，只看字节就会把没改过的文件和它的标注、旅程都判成"变了"。二进制文件按原字节。
 */
export function contentHash(buffer: Buffer, binary: boolean): string {
  const bytes = !binary && buffer.includes("\r\n") ? Buffer.from(buffer.toString("latin1").replace(/\r\n/g, "\n"), "latin1") : buffer;
  return createHash("sha256").update(bytes).digest("hex");
}

export interface IndexedFiles {
  files: FileRecord[];
  contents: Map<string, string>;
  viaGit: boolean;
  skipped: string[];
}

export async function indexFiles(root: string, excludePatterns: string[] = [], keepDotDirs: string[] = []): Promise<IndexedFiles> {
  const extra = excludePatterns.map(globToRegExp);
  const keep = new Set(keepDotDirs);
  const { files: candidates, viaGit } = await listCandidates(root);
  const files: FileRecord[] = [];
  const contents = new Map<string, string>();
  const skipped: string[] = [];
  const base = await fs.realpath(root);
  for (const rel of [...new Set(candidates)].sort()) {
    if (path.isAbsolute(rel) || rel.split("/").includes("..") || isExcluded(rel, extra, keep)) continue;
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
      hash: contentHash(buffer, binary),
      language,
      binary,
    });
    if (!binary && buffer.length <= MAX_PARSE_BYTES) contents.set(rel, buffer.toString("utf8"));
  }
  return { files, contents, viaGit, skipped };
}
