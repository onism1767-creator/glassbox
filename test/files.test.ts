import { test } from "node:test";
import assert from "node:assert/strict";
import { isExcluded, globToRegExp } from "../src/files.ts";

test("排除：数据库数据、缓存、以点开头的非源码目录不看；.claude、.github 保留；点开头的文件不受影响", () => {
  const none: RegExp[] = [];
  assert.equal(isExcluded(".pgdata/base/16389/2608", none), true);
  assert.equal(isExcluded(".hypothesis/examples/x", none), true);
  assert.equal(isExcluded(".somecache/a.py", none), true);
  assert.equal(isExcluded("app/.data/x.json", none), true);
  assert.equal(isExcluded(".claude/settings.json", none), false);
  assert.equal(isExcluded(".github/workflows/ci.yml", none), false);
  assert.equal(isExcluded(".gitignore", none), false);
  assert.equal(isExcluded("app/service.py", none), false);
  assert.equal(isExcluded(".env", none), true);
  assert.equal(isExcluded("docs/x.md", [globToRegExp("docs/**")]), true);
});

test("排除：overlay 的 keep_dot_dirs 能把点开头的目录放回来；固定名单里的（.venv）照样不看", () => {
  const keep = new Set([".ci", ".venv"]);
  assert.equal(isExcluded(".ci/run.py", []), true);
  assert.equal(isExcluded(".ci/run.py", [], keep), false);
  assert.equal(isExcluded("tools/.ci/run.py", [], keep), false);
  assert.equal(isExcluded(".venv/lib/x.py", [], keep), true);
  assert.equal(isExcluded(".other/x.py", [], keep), true);
});
