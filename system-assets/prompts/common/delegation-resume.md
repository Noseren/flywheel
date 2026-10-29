你之前委派的 Child Jobs 已全部达到终态。下面只包含最小结果与 artifact 引用，不包含 Child 的完整对话：

{{child_results}}

逐项读取必要 artifact，并按照首次委派时写入各 Child `task` 的领域契约分类：合格、缺失或不合格。合格 artifact 必须保留并直接用于聚合，不得重新运行对应执行单元；再次委派时只能包含 `failed`、`aborted`、`needs_input`、artifact 缺失或领域契约不合格的执行单元，并在新 `task` 中完整重述精确输出格式、所有必填字段和针对已发现问题的修正要求。不要把 Child 返回 `failed`、`aborted` 或 `needs_input` 伪装成成功；最终需要通用 JobResult 时写到 {{final_result_path}}。
