Contract 语义资产未通过 Runtime 的结构约束：{{issues}}

继续原 Contract Semantic 任务。本轮必须实际重新读取 {{goal_path}}、{{proposal_path}}、{{proposal_ref_path}} 和 {{context_card_path}}；当前文件内容是唯一权威版本。`boundary.json.artifact.path` 必须逐字复制 {{proposal_ref_path}} 的 `artifactPath`，不能改成方案正文提及的未来新文件。若 goal 要求接入公开基类、Protocol、抽象接口或项目标准行为，重新读取公开接口、相邻实现与现有测试，把直接蕴含的继承操作、组合路径和 laws 分别冻结；未知返回值或错误形状必须保留为未指定，不能猜测。只修复 {{contract_dir}} 中的 `task.md`、`requirements.json`、`boundary.json`、`tasking_guide.md`、{{manifest_path}} 和 {{result_path}}，不得生成 evaluator、测试样本、`evaluate_guide.md` 或 `coverage.json`。

`task.md` 必须原封不动包含完整用户 goal；`requirements.json` 必须把 goal 和批准方案中每项可独立评价的公开 artifact/输出要求拆成唯一 id，并保留精确名称、路径、格式、边界、兼容性、类型与 artifact 不变要求。`source` 只能是 `goal` 或 `proposal`。不得引入外部最终 verifier 的隐藏要求。评价拓扑、rubric 分工、禁止启发式代理语义、低分/缺证据处理、Smoke 范围以及 evaluator/collector 只读等评价方法约束由 Builder、Reviewer、Runtime 直接审计，只保留在 task/guide，不得成为候选 artifact 的业务 requirement 或元测试证明题。分支/commit 交付意图、Agent 不操作 Git、Runtime 写入/进程权限、snapshot/rollback/晋升等也只保留在 task/guide/boundary，不得成为 evaluator requirement 或未来 Agent 轨迹证明题。当前缺少的版本解释器或可选工具只形成条件证据，不得让 Contract 或 Init 失败。

manifest 使用 schemaVersion 2，且本阶段只声明固定路径的 `task`、`boundary`、`tasking-guide`、`requirements`。不得在修复时扩大晋级语义；Tasking 只执行候选并保存待评价证据，artifact 改动只属于 Refine；Runtime 独占 Git 与版本操作。`tasking_guide.md` 必须明确区分“候选命令失败”与“Tasking 基础设施失败”：前者是有效证据且 Tasking JobResult 返回 `completed`，不得在独立 Evaluate 前淘汰候选。

完成结构和逐项完整性自检后写通用 JobResult。业务错误返回 `failed`，缺少用户决定返回 `needs_input`。
