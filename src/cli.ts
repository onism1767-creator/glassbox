import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const command = args.shift() ?? "help";
const positional = args.filter((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1]?.startsWith("--")));
const flag = (name: string): boolean => args.includes("--" + name);
const option = (name: string): string | undefined => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : undefined;
};

const help = `glassbox · 画布是代码的函数

  glassbox init [仓库]                        写出 .workbench/overlay.yaml 模板，并把 .workbench 加进本地 git 排除
  glassbox doctor                            检查运行环境
  glassbox index [仓库] [--json]              索引文件与 import 图，打印摘要
  glassbox check [仓库] [--overlay 文件]       按规则检验分层违规、零依赖包、禁用词；有违规则退出码 1
  glassbox symbols [仓库] [--file 路径]        符号：函数、类、方法；调用边统计与未解析原因
  glassbox calls <符号> [仓库]                 某符号的调用者与被调用者（限定名、路径::限定名或名字）
  glassbox log [仓库] [--max N]               git 历史：阶段标签序列、热点、变更耦合
  glassbox baseline set [仓库] [--reason 文字] [--commit sha]
  glassbox baseline show [仓库]
  glassbox diff [仓库]                        基线到工作区的变更，按顶层目录投影
  glassbox snapshot [仓库] [--max-commits N]   全量快照：写 状态目录/snapshot.json 与 facts.sqlite
  glassbox serve [仓库] [--port 4400]          启动画布服务（先 npm run web:build）：首次全量，之后监听文件增量重算并实时推送
  glassbox hooks install [仓库] [--port 4400]  把 Claude Code hooks 装进仓库的 .claude/settings.json（SessionStart 记基线、PostToolUse 记触碰）
  glassbox hooks print [--port 4400]          只打印 hooks 配置，自己合并
  glassbox help                              显示本帮助

  --overlay 文件   用指定的 overlay.yaml 代替仓库内 .workbench/overlay.yaml
  --state 目录     状态目录，默认 仓库/.workbench
  --no-precise     不跑 pyright 精确层（只用语法层解析调用）
`;

const indexOptions = (): { overlayFile?: string; precise?: boolean } => ({
  ...(option("overlay") ? { overlayFile: option("overlay") } : {}),
  ...(flag("no-precise") ? { precise: false } : {}),
});

function resolveRoot(p?: string): string {
  const root = fs.realpathSync(path.resolve(p ?? process.cwd()));
  if (!fs.statSync(root).isDirectory()) throw new Error(`不是目录: ${root}`);
  return root;
}

function stateDirFor(root: string): string {
  const custom = option("state");
  return custom ? path.resolve(custom) : path.join(root, ".workbench");
}

async function main(): Promise<void> {
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(help);
      return;
    case "doctor": {
      const { doctor } = await import("./doctor.ts");
      await doctor();
      return;
    }
    case "init": {
      const root = resolveRoot(positional[0]);
      const { initWorkspace } = await import("./init.ts");
      const { overlayFile, created, excluded } = initWorkspace(root);
      process.stdout.write(`${created ? "已写出" : "已存在，未覆盖"}：${overlayFile}\n${excluded ? "已把 /.workbench/ 加进 .git/info/exclude\n" : ""}`);
      return;
    }
    case "index": {
      const { indexRepository, summarize } = await import("./index.ts");
      const result = await indexRepository(resolveRoot(positional[0]), indexOptions());
      process.stdout.write(flag("json") ? JSON.stringify(result, null, 1) : summarize(result));
      return;
    }
    case "check": {
      const { indexRepository, summarizeRules } = await import("./index.ts");
      const result = await indexRepository(resolveRoot(positional[0]), indexOptions());
      process.stdout.write(summarizeRules(result));
      if (result.violations.length) process.exitCode = 1;
      return;
    }
    case "symbols": {
      const { indexRepository, summarizeSymbols } = await import("./index.ts");
      const result = await indexRepository(resolveRoot(positional[0]), indexOptions());
      process.stdout.write(summarizeSymbols(result, option("file")));
      return;
    }
    case "calls": {
      const query = positional[0];
      if (!query) throw new Error("用法: glassbox calls <符号> [仓库]");
      const { indexRepository, summarizeCalls } = await import("./index.ts");
      const result = await indexRepository(resolveRoot(positional[1]), indexOptions());
      process.stdout.write(summarizeCalls(result, query));
      return;
    }
    case "log": {
      const root = resolveRoot(positional[0]);
      const { readOverlay } = await import("./config.ts");
      const { readHistory } = await import("./history.ts");
      const { formatHistory } = await import("./format.ts");
      const overlay = readOverlay(root, option("overlay"));
      const max = option("max") ? Number(option("max")) : undefined;
      const commits = await readHistory(root, { stageTag: overlay.stage_tag, ...(max ? { max } : {}) });
      process.stdout.write(flag("json") ? JSON.stringify(commits, null, 1) : formatHistory(commits));
      return;
    }
    case "baseline": {
      const sub = positional[0];
      const root = resolveRoot(positional[1]);
      const state = stateDirFor(root);
      const { setBaseline, readBaseline } = await import("./baseline.ts");
      if (sub === "set") {
        const b = await setBaseline(root, state, option("reason") ?? "manual", option("commit"));
        process.stdout.write(`基线已记录：${b.commit.slice(0, 9)}${b.branch ? " " + b.branch : ""}（${b.reason}）→ ${state}\n`);
        return;
      }
      if (sub === "show") {
        const b = readBaseline(state);
        process.stdout.write(b ? JSON.stringify(b, null, 2) + "\n" : "尚未记录基线。用 glassbox baseline set 记录。\n");
        return;
      }
      throw new Error("用法: glassbox baseline set|show [仓库]");
    }
    case "serve": {
      const root = resolveRoot(positional[0]);
      const state = stateDirFor(root);
      const { serve } = await import("./serve.ts");
      await serve(root, { stateDir: state, ...indexOptions(), port: Number(option("port") ?? "4400") });
      return;
    }
    case "hooks": {
      const sub = positional[0];
      const port = Number(option("port") ?? "4400");
      const { installHooks, hooksConfig } = await import("./hooks.ts");
      if (sub === "install") {
        const root = resolveRoot(positional[1]);
        const { file, created } = installHooks(root, port);
        process.stdout.write(`${created ? "已创建" : "已合并进"} ${file}\n新开的 Claude Code 会话会把事件发到 http://127.0.0.1:${port}/api/hook\n`);
        return;
      }
      if (sub === "print") {
        process.stdout.write(JSON.stringify({ hooks: hooksConfig(port) }, null, 2) + "\n");
        return;
      }
      throw new Error("用法: glassbox hooks install|print [仓库]");
    }
    case "snapshot": {
      const root = resolveRoot(positional[0]);
      const state = stateDirFor(root);
      const { writeSnapshot, summarizeSnapshot } = await import("./snapshot.ts");
      const max = option("max-commits") ? Number(option("max-commits")) : undefined;
      const { snapshot, jsonPath, dbPath } = await writeSnapshot(root, { stateDir: state, overlayFile: option("overlay"), ...(max ? { maxCommits: max } : {}) });
      process.stdout.write(summarizeSnapshot(snapshot) + `已写出 ${jsonPath}\n已写出 ${dbPath}\n`);
      return;
    }
    case "diff": {
      const root = resolveRoot(positional[0]);
      const state = stateDirFor(root);
      const { readBaseline, diffSinceBaseline } = await import("./baseline.ts");
      const { formatDiff } = await import("./format.ts");
      const b = readBaseline(state);
      if (!b) throw new Error("尚未记录基线。用 glassbox baseline set 记录。");
      const result = await diffSinceBaseline(root, b);
      process.stdout.write(flag("json") ? JSON.stringify(result, null, 1) : formatDiff(result));
      return;
    }
    default:
      process.stderr.write(`未知命令: ${command}\n${help}`);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
