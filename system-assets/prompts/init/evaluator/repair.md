独立评价资产未通过 Runtime 或 Smoke 校验：{{issues}}

继续原 Evaluator Builder 会话。重新读取 {{goal_path}}、{{proposal_path}}、{{task_path}}、{{requirements_path}} 和 {{tasking_guide_path}}。只修复评价资产、{{manifest_path}} 与 {{result_path}}；不得修改冻结的 task、requirements、boundary 或 tasking guide，也不得向 Flywheel Manager 询问候选实现问题。

重新核对错误的作用域，不把上一轮自己的失败结论当成契约原文。task 中明确限定“as part of this contract stage”或“本 Contract Semantic 阶段不创建 evaluator/测试/runner”的文字，只限制上一阶段，不禁止当前已授权 Evaluator Builder 创建评价资产；正常 Run 的候选仍不得修改冻结评价资产。不得据此忽略用户的跨阶段禁令或真正的语义冲突；冻结语义文件仍只读。若上一轮仅因误读阶段职责而失败，在不修改任何冻结语义文件的前提下纠正解释并完成本阶段。

Guide 采用 agent/LLM 执行时，正常 Tasking 及其原生 Child Job 本身就是实际模型能力，不需要新 provider 工具、外部 runner 或用户凭据。采集入口接收并原样保留 Tasking/Child 真实原始输出及轨迹，不得硬编码全部 unavailable，不得生成或润色答案。修复冻结输入交接与采集计划；Init 自检可用明确标记的合成 fixture 检验链路，不能声称这些是未来候选的真实输出，业务效果仍由 Smoke/正常 Run 独立验证。

评价执行只读：禁止使用任何自动修复、原地格式化、代码重写或快照/golden 更新功能改变基线、候选或原始数据；此限制同样适用于修复自检、委派 Child、生成的测试、evaluator、证据入口和 guides。修复评价资产不代表可以修复被评价对象。重新读取项目配置、包装脚本和工具选项，检查隐式自动修复开关；例如 Ruff 遇到 `fix = true` 时必须在生成的检查命令中显式使用 `ruff check --no-fix ...`，不得使用 `--fix`、`--write`、`--update-snapshots` 等写回行为。不得修改项目配置，不得先修复再评价；把只读命令同步到冻结执行计划，并核对执行前后被评价文件没有变化。无法安全执行所需检查时停止调用并返回 `failed`，不得执行后再回滚、静默跳过检查或伪造通过。

{{project_native_strategy}}

保持评价职责完整：`evaluate_guide.md` 提供每项 requirement 的证据与细则；真实可执行 evaluator 只代码化无歧义真值；Code Project 优先产生项目原生的独立测试文件和 Tasking 的冻结证据入口；现有 `collector` 名称只是 manifest 兼容角色，不是额外运行层。`coverage.json` 使用 schemaVersion 2，每个 check 只能映射一个 requirement，并提供唯一的 `<artifact-id>#<精确选择器>` locator 与完整 oracle provenance。exact oracle 必须包含 JSON expected、goal/contract/project 来源精确位置及推导；无法排除另一个同样满足冻结需求的结果时，改成 semantic 且不得保留 expected。不得给共享测试名追加 requirement id、注释或任意后缀来伪造唯一 locator。不要让多个公开要求共享同一 locator，不要把它们合并成一个笼统 happy-path 检查；可确定执行的 Code Project 要求必须实际执行对应 locator，不能只写进 guide。根据独立 Reviewer 的逐项证据重新读取项目公开接口、相邻实现和现有测试，修正导入、调用方向、参数顺序、错误形状、返回类型、继承操作及组合 laws；不得读取外部最终 verifier。不得用关键词、正则或启发式语义代理。正常 Run 计划必须把 cwd/argv 结构化冻结，仅保留完整值 token `__FLYWHEEL_CANDIDATE_ROOT__` 与 `__FLYWHEEL_OUTPUT_DIR__` 供 Runtime 按轮绑定；前者表示完整项目或 candidate worktree，不能绑定为其中的 artifact 子路径。不得写死 runtime、v1、Smoke、自检或绝对输出路径，也不得让 Tasking 调用 evaluator。临时目录、HOME 与工具缓存必须隔离到绑定后的 output。路径不得未经真实解析验证就嵌入 `kind:path`、`option=path` 或测试框架 `addopts`；在 Windows 必须使用不会吞掉反斜杠和盘符的独立 argv 或正斜杠表示，并重跑 normal full 分支、比较候选 fixture 前后变更，证明所有派生产物都在 output。正常 Run output 既可能位于完整候选工作区内，也可能与隔离 candidate worktree 并列：涉及候选复制、遍历、归档或 hash 时，前者必须从解析后的绝对路径计算并排除完整 output 子树，后者不得被误读为候选或因不在候选内而被拒绝；先判定路径关系再创建任何输出。不得只按 basename 排除，不得让 snapshot 递归包含自身，也不得要求 Smoke 或 Tasking 通过候选镜像、包装脚本或预处理复制补救证据入口。

修复声明式 law/spec requirement 时，不能只加强具体容器的运行时样例。必须验证被注册的 law 本身构造正确输入、执行目标操作、覆盖 requirement 中每个短路/累积/顺序分支并作出等式或其他可观察断言；同时加入空洞 law、传统但不适用的 law、错误等式和缺少一个组合分支的反例自检。只探测 law 名称、数量、方法调用痕迹或任意 AssertionError 不足以判定完整性。

若问题来自 Smoke，只修复执行链路或评价资产，并重新执行必要自检。正常 Run 的全覆盖不能缩减为 Smoke 的一个代表单元。完成后写通用 JobResult；无法可信评价则如实返回 failed。

修复时不得把“当前没有某个兼容矩阵解释器/可选工具”误当成 evaluator 设计失败；应生成条件执行与结构化 `unavailable` 证据，并在当前环境自检缺席分支。也不得为了证明 Runtime 独占的 Agent 写入、Git/进程权限或版本动作去读取或伪造未来 Run 轨迹；这些不是业务 evaluator 职责。评价拓扑、rubric 分工、禁止启发式代理语义、低分/缺证据处理、Smoke 范围和 evaluator/collector 只读同样是评价设计规则，不得为它们生成针对 evaluator 源码的元测试；若冻结 requirements 混入这些规则，返回 Contract 矛盾，而不是用有限 AST 或关键词黑名单尝试自证。
