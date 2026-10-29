评价产物协议无效：{{issues}}
同一会话仅修复 {{report_path}}、{{result_path}} 的声明、路径或协议，不把真实失败改成成功。不得在修复中执行、投影或补生 Init Smoke 输入。
候选缺少入口/输出/证据、全部 rubric 失败、零分或 `incomplete` 是领域评价结果，不是 Job 执行失败；若评价 artifact 已真实完成，Child 与父 Evaluate 的 JobResult 均应为 `completed`，报告保留原失败结论。只有评价过程自身无法执行或无法形成可信 artifact 才保持 `failed`/`needs_input`。

{{base_prompt}}
