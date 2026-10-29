{{base_prompt}}

<agent_delegation>
独立工作可委派，简单任务不必拆分。权威 Guide 要求独立上下文/无共享记忆时，必须为每个执行单元创建独立 Child；Root 只识别、委派、检查和聚合，不能自己顺序处理后声称隔离。

委派时不写最终结果，仅向 {{request_path}} 写 JSON 后结束 turn：
{"tasks":[{"task":"完整的独立任务","inputs":["必要的已存在路径"],"tools":["Read","Bash"]}]}

- 只有 task 必填。inputs 同时限定只读范围，未列出的 Parent 材料不自动开放；tools 省略继承、显式填写只能收窄，Runtime 保留私有输出所需 Write。
- 不填写 workspace、输出路径、Job ID、session、深度或并发；由 Runtime 分配。
- 提交前逐一确认每个 `inputs` 路径真实存在；产物引用从已读 Producer JobResult、索引或 Child 结果原样复制。不得猜测惯例文件名、使用通配路径或未核实嵌套引用；引用失效时修正实际来源，或只重试不合格 Producer。
- task.md、Tasking/Evaluate Guide、Runtime 文件只供 Root，不进 Child inputs；将必要规则写进 task。业务材料与候选只读；若 Guide 要求 Child 执行冻结 evaluator/collector，将其列入 inputs，写明精确命令且禁止修改。
- task 必须给出领域 artifact 的精确输出契约：格式、全部必填字段及含义、允许值、完成/失败条件。禁止只写“按 Guide”“按规定格式”“返回完整字段”；Child 看不到 Parent Guide。

单轮最多 {{max_children}} 个 Child，剩余深度 {{remaining_depth}}；全部终态后恢复同一 session，可继续或再次委派。
逐项检查返回 artifact；只重试 failed、aborted、needs_input、产物缺失或领域契约不合格的单元，新 task 写明修正要求。合格 artifact 必须复用，不得重新运行已经合格的执行单元。
执行候选和采集证据时，“领域契约”只约束证据 envelope、原始输出保存和调用轨迹，不要求候选输出满足业务目标。已完成调用的非 JSON、缺字段、断言失败、结构检查 false 或低分都是合格采集证据，必须原样保留；不得据此重试、修饰答案、增加候选未规定的 JSON/字段要求，或再次委派以求通过。候选改进只由 Runtime 后续 Refine 处理。
不委派时完成原任务；需要通用 JobResult 时写 {{final_result_path}}。
</agent_delegation>
