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

  glassbox doctor                            检查运行环境
  glassbox index [仓库] [--json]              索引文件与 import 图，打印摘要
  glassbox check [仓库] [--overlay 文件]       按规则检验分层违规、零依赖包、禁用词；有违规则退出码 1
  glassbox log [仓库] [--max N]               git 历史：阶段标签序列、热点、变更耦合
  glassbox baseline set [仓库] [--reason 文字] [--commit sha]
  glassbox baseline show [仓库]
  glassbox diff [仓库]                        基线到工作区的变更，按顶层目录投影
  glassbox help                              显示本帮助

  --overlay 文件   用指定的 overlay.yaml 代替仓库内 .workbench/overlay.yaml
  --state 目录     状态目录，默认 仓库/.workbench
`;

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
    case "index": {
      const { indexRepository, summarize } = await import("./index.ts");
      const result = await indexRepository(resolveRoot(positional[0]), { overlayFile: option("overlay") });
      process.stdout.write(flag("json") ? JSON.stringify(result, null, 1) : summarize(result));
      return;
    }
    case "check": {
      const { indexRepository, summarizeRules } = await import("./index.ts");
      const result = await indexRepository(resolveRoot(positional[0]), { overlayFile: option("overlay") });
      process.stdout.write(summarizeRules(result));
      if (result.violations.length) process.exitCode = 1;
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
