Execute the task according to its frozen tasking guide. Do not optimize or grade the artifact.
Subject root: {{subject_root}}
Artifact: {{artifact_path}}
Original goal: {{goal_path}}
Task: {{task_path}}
Frozen guide: {{guide_path}}
Train data: {{train_path}}
Holdout data: {{holdout_path}}
Write actual outputs and execution evidence only inside {{outputs_dir}}.
Execute the real artifact on the guide's units. A baseline may fail business checks; do not replace it with a synthetic demonstration. Keep train and holdout output separate as specified by the guide. Do not read evaluator internals, change source files, call external model APIs, spawn subagents, or claim success without execution. Your own model invocation is already managed by Runtime.
Finish by writing {{result_path}} as JSON {"status":"completed|failed|needs_input","artifacts":["absolute evidence path"],"message":"brief result"}. On failure explain the actual blocker. Do not fabricate missing evidence.
