---
name: glassbox-journey
description: 给 glassbox 画布写旅程——"这件事从哪个入口开始，依次经过哪些文件或函数"，并指定能验证它的测试。当用户说"画一条旅程""这个功能是怎么走的""把诊断流程标出来""验证旅程"时用。
---

# 给画布写旅程

旅程是一个**假设**：从入口开始依次经过哪些代码。你只负责提出；连不连得上（静态）和真的走没走过（动态）都由机器算，你不要写"已验证"。

## 步骤

1. 看入口候选和现有旅程：

   ```bash
   glassbox journey entries <仓库>     # 路由、CLI 子命令、main，机器扫出来的
   glassbox journey list <仓库>        # 现有旅程和状态
   ```

2. 挑一个入口，读它的代码，顺着调用往下读，列出依次经过的文件（精确到函数更好：`sym:路径::限定名`）。每步 2 到 30 个，相邻两步不能重复，步骤不能是目录。

3. 找能验证它的测试：看 `tests/` 里哪些测试从这个入口跑到最后一步（整个测试文件或单个用例 `tests/x.py::test_y` 都行）。没有就不写 `verify`，但要告诉用户"这条只能静态检验"。

4. 写成 JSON 数组存到临时文件：

   ```json
   [
     {
       "id": "diagnose-class",
       "name": "一类问题从指标到结论",
       "role": "聚合后的指标进诊断层，判成阶段结论，再组成报告里的话",
       "steps": [
         { "node": "file:engine/aggregate.py", "note": "算指标" },
         { "node": "file:diagnosis/diagnose.py", "note": "判阶段" },
         { "node": "file:diagnosis/assemble.py" },
         { "node": "file:report/narrative.py", "note": "组句" }
       ],
       "verify": { "tests": ["tests/unit/test_recommender_diagnose.py"] }
     }
   ]
   ```

   `id` 小写字母、数字、`-`；`name` ≤ 40 字；`role` ≤ 200 字；`note` ≤ 80 字。

5. 交上去，然后跑验证：

   ```bash
   glassbox journey set <仓库> --file 批.json --author claude
   glassbox journey verify <id> <仓库>
   ```

   `set` 的报告会说退回了哪些（步骤不存在、测试文件不在索引里…），改了再交。`verify` 带覆盖率跑指定的测试，真实碰到全部步骤才算已验证（T3）；"只碰到了 k/n 步"说明旅程或测试选得不对，回去看代码。

6. 画布上：旅程面板一步一步列出来，相邻两步之间写明机器找到的连接（直接 import、经过几个文件、反向、由谁串起来、断链）；"断链"是静态图上找不到路，可能是动态分发，也可能是你写错了——读代码确认。代码之后改了，已验证会变成"验证过时"，重跑 `verify` 即可。
