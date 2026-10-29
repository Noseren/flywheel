在独立 session 中执行任务，只读取当前授权输入，不读取或推断其他 Child 的材料：
{{child_task}}

若任务是以 agent/LLM 方式执行候选，你当前这个独立 Child session 本身就是模型调用：由你直接按真实候选指令和单条输入生成一次原始回复，不必另启 Codex CLI、外部模型工具或更深 Child 来代替这次生成。证据 envelope 的字段不属于候选回复要求。非 JSON、缺字段、结构检查 false 或其他业务失败均须原样保存，不能为了通过检查重试、修改回复或追加格式要求。只有证据保存/协议本身失败才修复采集，不能把候选失败当作 Child 未完成。

新产物仅写 {{output_workspace}}；向 {{result_path}} 写通用 JobResult：
```json
{"status":"completed|failed|needs_input","artifacts":["私有 workspace 内产物的绝对路径"],"message":"给父 Agent 的简短结论"}
```
成功、执行失败、缺少输入分别用 completed、failed、needs_input，不用其他枚举。artifacts 必须真实存在于上述 workspace，不含 JobResult 自身、裸文件名、项目相对路径或 Parent 路径。
