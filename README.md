# Flywheel

让 AI 持续改进你的项目，并留下每一步的验证结果。

给 Flywheel 一个目标，例如“修好库存预留逻辑”或“让客服 Prompt 稳定输出 JSON”。它会先检查当前表现，再让 Agent 修改、验证，并决定是否保留改进。

**当前为源码开发预览。** 支持 Prompt、Skill 和非视觉代码项目，提供终端与实验性 Windows 桌面界面。模型调用使用你的账号，会产生费用。

`preview.2` 为新任务加入按需组件路由和独立目标判定。复杂任务仍可能需要人工介入，部分高级组件尚未完成真实场景验证。

## 它解决什么问题

让 AI 改一次代码并不难，难的是判断改得是否更好，以及失败后如何继续。

Flywheel 的思路很简单：

- **先看起点**：实际运行检查，记录修改前的表现。
- **用相同标准比较**：修改前后使用固定的评价标准。
- **验证后再保留**：在独立副本中尝试，失败不会覆盖正式成果。
- **控制尝试成本**：记录消耗和失败，达到预算后暂停。

## 开始使用

需要 **Node.js ≥22.19.0、Git、pnpm 11.25.0**，以及可正常使用、已认证的 **Codex CLI**。仅使用终端不需要 Docker 或 Rust。

```powershell
git clone https://github.com/Noseren/flywheel.git
cd flywheel
pnpm install --frozen-lockfile
pnpm run build
```

先把 `examples/code-project/inventory-reservation-mock` 复制到仓库外的新目录，例如 `C:/flywheel-demo/inventory`。这是一个无需额外依赖的库存小项目，故意保留了几处错误。

在 Flywheel 仓库根目录运行：

```powershell
node dist/cli.js --project C:/flywheel-demo/inventory init --goal-file C:/flywheel-demo/inventory/goal.md
```

确认目标与评价方案后，Flywheel 会记录原始版本的失败测试，再尝试修改和验证。你可以在任务中查看每次评价和版本保留结果。

默认使用 `gpt-5.6-luna`。若账号不支持该模型，可指定你能使用的模型：

```powershell
node dist/cli.js dev init --project C:/flywheel-demo/inventory --goal-file C:/flywheel-demo/inventory/goal.md --model YOUR_AVAILABLE_MODEL
```

Flywheel 将模型会话保存在独立的 `~/.flywheel/codex` 目录，首次尝试复制已有 Codex 的认证与配置。若认证不可用，需要为该目录配置认证；可通过 `FLYWHEEL_CODEX_PATH` 指定 Codex 可执行文件。

## 三个演示项目

每次从新的副本开始，把其中的 `goal.md` 作为目标输入。

| Demo | 体验内容 | 输入目录 |
| --- | --- | --- |
| 库存预留 | 从失败测试开始修复一个小函数，推荐首次使用 | `examples/code-project/inventory-reservation-mock` |
| 客服 Prompt | 改进 JSON 输出、事实约束和转人工规则 | `examples/prompt/support-reply-mock/project` |
| 订单履约 | 处理库存、金额和重复提交之间的多模块问题 | `examples/code-project/order-fulfillment-mock` |

两个代码 demo 可直接运行 `node --test`，初始版本故意有测试失败；客服 demo 的输出和评价需要模型调用。

## 预算与继续运行

新任务默认最多尝试 **3 个候选方案、15 分钟活跃执行、50 万已知输入/输出 tokens**。准备、评价和失败尝试都计入预算。模型延迟回报用量时，在途调用可能超限。

创建任务时可用 `--max-attempts`、`--max-active-ms`、`--max-tokens` 调整。更多参数见：

```powershell
node dist/cli.js --help
```

终端支持 `/abort`、`/resume`、`/stop`。初始化完成后，用同一项目路径继续：

```powershell
node dist/cli.js --project C:/flywheel-demo/inventory run
```

初始化尚未完成时继续使用 `init`；指定过模型时保持相同配置。保留项目里的 `.flywheel/`，其中保存恢复所需记录，恢复不会重置预算。

暂停时会显示当前版本、判定摘要和未决事项，并提供完整报告入口。“证据不足”会保留成果并暂停，等待补充验证或明确验收口径；测试通过与完整目标达成分别显示。

## 可选：Windows 桌面界面

另需 Rust/Cargo、WebView2 和 Visual Studio C++ 构建工具：

```powershell
pnpm desktop:build
node dist/cli.js gui
```

选择项目后可在主对话确认和干预任务，查看 Agent 工作与正式结果。运行桌面程序时需保留源码目录和 Node.js 环境。

## 边界与开发

请从有备份的项目副本开始，不要同时用两个进程操作同一项目。文件范围和版本检查不是操作系统级沙箱；模型请求会向提供方发送任务内容。不要公开账号文件、运行日志或带 token 的界面地址。

开发检查：`pnpm run check`、`pnpm test`、`pnpm run build`。自动化测试不调用真实模型。反馈问题请提供环境、最小复现和脱敏错误，通过 [Issues](https://github.com/Noseren/flywheel/issues) 提交；安全漏洞请使用[私下报告入口](https://github.com/Noseren/flywheel/security/advisories/new)。

想了解背后的流程和设计，阅读[技术介绍](docs/technical-overview.md)。主项目原创代码使用 [MIT](LICENSE)，依赖与模型服务遵循各自条款。
