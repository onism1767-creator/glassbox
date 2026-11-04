import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installSkill } from "../src/skill-install.ts";

test("装 skill：front-matter 保持在最前面，开头生成本项目的调用方式，重复装不叠加", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "glassbox-skill-"));
  try {
    const state = path.join(repo, "..", "some-state");
    const overlay = path.join(repo, "overlay.yaml");
    const dst = installSkill("glassbox-annotate", repo, { stateDir: state, overlayFile: overlay, port: 4411 });
    assert.equal(dst, path.join(repo, ".claude", "skills", "glassbox-annotate", "SKILL.md"));
    const text = fs.readFileSync(dst, "utf8");
    assert.ok(text.startsWith("---\nname: glassbox-annotate"), "front-matter 必须在最前面，Claude Code 才认");
    assert.match(text, /## 本项目怎么调用/);
    assert.match(text, /bin\/glassbox\.js"/);
    assert.ok(text.includes(`--state "${path.resolve(state).split(path.sep).join("/")}"`));
    assert.ok(text.includes(`--overlay "${path.resolve(overlay).split(path.sep).join("/")}"`));
    assert.match(text, /127\.0\.0\.1:4411/);
    assert.match(text, /glassbox annotate todo/, "原来的步骤还在");
    const first = text.indexOf("## 本项目怎么调用");
    assert.ok(first < text.indexOf("# 给画布写人话标注"), "生成的那段在正文标题之前");

    installSkill("glassbox-annotate", repo, { stateDir: state, port: 4400 });
    const again = fs.readFileSync(dst, "utf8");
    assert.equal(again.split("## 本项目怎么调用").length, 2, "重复装只保留一段");
    assert.doesNotMatch(again, /--overlay/, "第二次没给 overlay 就不写");

    const journey = installSkill("glassbox-journey", repo, { stateDir: state, port: 4400 });
    assert.match(fs.readFileSync(journey, "utf8"), /^---\nname: glassbox-journey/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
