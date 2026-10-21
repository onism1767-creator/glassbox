import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { indexRepository } from "../src/index.ts";

const fixtures = path.join(import.meta.dirname, "fixtures");
const root = path.join(fixtures, "mini-py");
const overlayFile = path.join(fixtures, "mini-py-overlay.yaml");

test("规则从守卫测试的字面量读出，带文件与行号来源，等级 T0", async () => {
  const result = await indexRepository(root, { overlayFile });
  assert.deepEqual(result.rules.layers, { core: 1, util: 1, app: 2, web: 3 });
  assert.deepEqual(result.rules.allowed.map((a) => [a.from, a.to]), [["core", "app.models"]]);
  const layers = result.rules.provenance.find((p) => p.what === "layers");
  assert.equal(layers?.tier, "T0");
  assert.equal(layers?.evidence?.path, "tests/test_layers.py");
  assert.equal(layers?.evidence?.line, 1);
  assert.deepEqual(result.ruleProblems, []);
});

test("抓到下层 import 上层的违规，白名单例外放行并指回来源", async () => {
  const result = await indexRepository(root, { overlayFile });
  const direction = result.violations.filter((v) => v.rule === "layer-direction");
  assert.deepEqual(direction.map((v) => [v.evidence.path, v.evidence.line, v.to]), [["core/io.py", 1, "web/views.py"]]);
  assert.deepEqual(result.allowed.map((a) => [a.evidence.path, a.to, a.allowedBy?.line]), [["core/compat.py", "app/models.py", 2]]);
});

test("零依赖包 import 项目包即违规；禁用词按整词匹配、不分大小写", async () => {
  const result = await indexRepository(root, { overlayFile });
  const isolated = result.violations.filter((v) => v.rule === "isolated-package");
  assert.deepEqual(isolated.map((v) => [v.evidence.path, v.to]), [["util/text.py", "app/models.py"]]);
  const words = result.violations.filter((v) => v.rule === "forbidden-word");
  assert.deepEqual(words.map((v) => [v.evidence.path, v.evidence.line, v.evidence.note]), [["app/bad.py", 1, "OpenAI"]]);
});

test("上层依赖下层、同包内部、相对导入都不算违规", async () => {
  const result = await indexRepository(root, { overlayFile });
  const offenders = new Set(result.violations.map((v) => v.evidence.path));
  for (const ok of ["app/service.py", "web/views.py", "web/helpers.py"]) assert.ok(!offenders.has(ok), ok);
});
