读取 {{context_card_path}}，基于项目证据和用户初始目标提出一套完整、简洁的 Flywheel 初始化建议。用户目标是本次任务的权威需求；不得遗漏、替换或自行收窄它：

原始目标也已由 Runtime 持久化在 {{goal_path}}。生成完成前逐项核对其中明确出现的类名、函数名、字段名、路径、数据结构和精确格式；这些标识符即使未在项目证据中重复出现，也必须原样保留在方案中。项目证据用于补充实现上下文，不能覆盖原始目标。

<user_goal>
{{user_goal}}
</user_goal>

优先复用项目已有的运行方式、自然数据划分、测试和确定性评分工具。不要读取或使用项目最终 test 作为优化数据。评价拓扑必须服从任务本身，而不是为了满足模板拆分：Prompt、Skill、Agent 输出或项目已有自然独立样本集合时，规划 train 和 holdout，Runtime 每轮分别执行、评价二者，只把 train 证据交给 Propose，把 holdout 留给 Select 和独立 Target Assess；有限公开规格、完整公开功能清单或整体 Code Project 检查采用无数据分区的 candidate 模式，让全部公开要求都进入 Propose 可见的正式评价。不得仅因测试可以枚举就合成 holdout。Code Project 只有在项目确实已有语义合理的独立测试集合时才可拆分，并确保每项明确公开要求都在 train 可见；holdout 只覆盖替代取值、组合和鲁棒性，不能独占一项公开需求。外部最终 test/verifier 始终独立于 Flywheel，不属于 train 或 holdout。

对任何准备写成正常 Run 必需命令、工具或晋级门的内容，先根据项目源码核对精确执行范围与副作用，并在当前环境做安全的可用性验证；不得仅凭包名、目录名或命令表面形式宣称它不会启动服务、端口、网络或后台进程。已知会被受限环境阻止的命令，以及当前不存在且无项目内可复现调用方式的工具，不得被规划为必然导致评价不完整的门；应改用安全精确命令或当前环境可执行的等价证据。

项目声明的多版本支持矩阵、可选解释器或可选质量工具只有在用户目标明确要求，或项目公开兼容契约直接要求时才进入验收范围；不能因为配置中出现一个版本号就扩大目标。即使它确属验收范围，当前环境中不存在的解释器或工具也只能规划为条件证据：collector 记录 `available / unavailable`，存在时真实执行，不存在时由 Evaluate/Target Assess 如实标记该维度证据不足。不得要求 Init 预先安装全部矩阵、不得把缺少可选环境本身变成 evaluator 生成失败或 Init hard-fail，也不得用语法解析冒充真实运行。

分支、commit、snapshot、rollback 和版本晋升由 Runtime 的隔离 worktree 与版本服务负责，不是 Agent Worker 或 evaluator 的业务动作。若用户目标包含“从 main 建分支”“提交改动”等交付措辞，把它保留为隔离修改和持久版本记录的意图，并说明由 Runtime 实现；不得假定指定 Git ref 一定存在，不得要求 Refine/Tasking/Evaluate 执行 git checkout、建分支或 commit，也不得把分支名、用户仓库 commit 或 Git 工作树状态写成业务评分项、hard-fail 或评价完整性条件。
Runtime 对 Agent 写入范围、Git/进程操作和版本动作的审计也不属于业务 evaluator 的输入或 requirement；Proposal 不得要求 Init Reviewer 预先取得未来 Run 才会产生的 Agent 轨迹。

普通功能需求和验收目标仍然是任务要求，但不是红线；只有用户明确表示某项条件不可退让、属于红线或必须作为晋级硬条件时，才把它定义为红线。除非用户明确要求绝对门槛，Select 只能根据证据完整性以及候选相对当前晋升版本的改进决定是否晋升；目标是否完全达成应单独表达，不得把目标分数或通过率写成最低合格、晋级门槛或 hard-fail。普通功能失败是有效低分证据；hard-fail 仅限无法可信评价、产物完整性或 Runtime 安全边界失败，以及用户明确声明的红线。评价应衡量实际输出或完整候选行为，不评价代码或 Prompt 看起来是否漂亮。

{{schema_prompt}}
