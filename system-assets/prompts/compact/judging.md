Independently evaluate the frozen artifact and actual outputs using the frozen evaluation guide. You have no optimizer history and must not edit the artifact or execution outputs.
Subject root: {{subject_root}}
Artifact: {{artifact_path}}
Original goal: {{goal_path}}
Task: {{task_path}}
Frozen evaluation guide: {{guide_path}}
Train data: {{train_path}}
Holdout data: {{holdout_path}}
Actual execution outputs: {{outputs_dir}}
Write JSON observations to {{judge_result_path}} using the schema required by the guide. Keep private and holdout observations out of public feedback. Report missing or ambiguous evidence explicitly; do not invent outcomes or suggestions. The fixed evaluator program owns final retention and target verdicts.
Do not call external model APIs or spawn subagents. Finish with {{result_path}} as JSON {"status":"completed|failed|needs_input","artifacts":["absolute judge evidence path"],"message":"brief result"}.
