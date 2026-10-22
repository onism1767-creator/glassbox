# glassbox

**画布是代码的函数。** The canvas is a function of the code.

给用 AI 编程的人的实时仪表盘：代码结构、进度、待办全部由机器从代码、git、测试和 agent 事件推导出来。LLM 只负责贴标签，标签随代码变化自动失效。

## 为什么做

用 Claude Code 这类工具开发时，有三个看不见：看不见代码结构，看不见进度真相，看不见清晰的待办。三者根因相同：所有"看见"都经过 agent 的消化和汇报，没有任何机制校验汇报与代码是否一致。画布由 agent 维护，本质上是一张 PPT。

## 原则

- **结构只由机器推导。** 节点和边来自文件系统、import 解析、符号索引、git、测试结果、hook 事件。LLM 和人只能贴标签、提假设。
- **真相分级，由来源决定，不能自报。** T0 观测、T1 推导、T2 声明、T3 机器验证。"已验证"这个词只有检验器能写。
- **实时有精确定义。** 事实更新秒级；LLM 标注移出主路径，节流，过期灰显。
- **进度等于流程层加证据层。** 状态机说谁该做什么，证据层算 agent 触碰、提交引用、测试结果、验收 SHA，两层不一致标红。
- **架构规则进图。** 分层方向和禁用词写成规则，每条依赖边机械判定，违规标红。

## 状态

阶段 3 完成：事实索引器到符号级。它读文件、解析 import、从项目自己的守卫测试读分层规则并检验违规、提取函数与类与方法、解析调用边（语法层 + pyright 精确层）、读 git 历史与阶段标签、算会话基线差异，写出 snapshot.json 与 facts.sqlite。画布、实时、任务与证据层还没有。

```bash
npm install
node src/cli.ts doctor
node src/cli.ts check <仓库> --overlay <overlay.yaml>
node src/cli.ts symbols <仓库>
node src/cli.ts calls <函数或类名> <仓库>
node src/cli.ts log <仓库>
node src/cli.ts baseline set <仓库> --reason "会话开始"
node src/cli.ts diff <仓库>
node src/cli.ts snapshot <仓库>
```

设计文档按时间顺序：

1. [规划讨论稿 v0](规划讨论稿-v0.md)：问题、原始素材、市面工具、技术路线
2. [nativue-ai 评估与接入方案](nativue-ai%20评估与接入方案.md)：对参照项目的逐项评估
3. [设计稿 v1](设计稿-v1-代码驱动的实时仪表盘.md)：原则与真相分级
4. [设计稿 v1.1](设计稿-v1.1.md)：定稿，含每一步的技术实现方式与备选
5. [设计稿 v1.2](设计稿-v1.2.md)：宏观文档读取、每任务进度条与预计时间，每个数字标来源与真相等级
6. [阶段 1 对照记录](docs/阶段1-对照/阶段1-对照记录.md)：原版 nativue-ai 在 GEO 工具上的 Windows 实测
7. [阶段 2 记录](docs/阶段2-索引器/阶段2-记录.md)：事实索引器，与 GEO 守卫测试结论一致
8. [阶段 3 记录](docs/阶段3-符号级/阶段3-记录.md)：符号级调用图，语法层加 pyright 精确层，GEO 手工核对

技术决定：TypeScript on Node 24；tree-sitter 做语法结构；符号级调用图用 tree-sitter 语法层加 pyright 语言服务器精确层（原定的 scip-python 在 Windows 启动即崩，见阶段 3 记录）；node:sqlite 做事实库；React Flow 加 ELK 做画布；任务是仓库内 Markdown 文件；Claude Code hooks 做实时事件，协议本身与 AI 工具无关。

## 致谢

- **[nativue-ai](https://github.com/Xiange-Sienna/nativue-ai)**（SienGe AI Lab，MIT）。本项目的直接参照。它把"扫描事实、LLM 解释带证据、导入校验、A/B/C 任务台账"做成了可运行的工具。glassbox 在此基础上反转结构的话语权：机器图是唯一结构，LLM 只写绑定到真实节点的解释。凡直接复用的代码保留其版权声明。
- **原帖**。小红书账号「SienGe的AI实验室」关于 Figma 式代码架构画布与 A、B、C 分工的分享，是整个想法的起点。

## License

MIT
