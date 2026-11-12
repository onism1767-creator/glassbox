import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readOverlay } from "../src/config.ts";
import { runCommand } from "../src/runtests.ts";

test("overlay 的 test_results.env：只收字符串值；跑命令时真的传给子进程（Q-8：测试用画布自己的库）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glassbox-env-"));
  try {
    const file = path.join(dir, "overlay.yaml");
    fs.writeFileSync(file, "version: 1\ntest_results:\n  auto: false\n  env:\n    GEO_TEST_DB: geo_tool_glassbox\n    NOT_A_STRING: 5\n", "utf8");
    const o = readOverlay(dir, file);
    assert.deepEqual(o.test_results?.env, { GEO_TEST_DB: "geo_tool_glassbox" });
    assert.equal(o.test_results?.auto, false);
    assert.equal(readOverlay(dir, path.join(dir, "none.yaml")).test_results?.env, undefined);

    const r = await runCommand(process.execPath, ["-e", "process.stdout.write('db=' + process.env.GEO_TEST_DB)"], dir, { ...process.env, ...o.test_results!.env }, undefined, 30_000);
    assert.equal(r.code, 0);
    assert.match(r.tail, /db=geo_tool_glassbox/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
