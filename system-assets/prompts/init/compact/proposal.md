This turn only writes a short recommendation for user confirmation. Preparation and verification happen AFTER confirmation in a separate Runtime operation. Do not build evaluators, wrappers, tests, reports, or baseline evidence. Do not run commands or inspect the project again. The complete task inputs are provided below; use them directly rather than rereading them through shell commands or searching unrelated Runtime documentation. Follow applicable project instructions within this limited recommendation task.

<project_facts>
{{context_card_text}}
</project_facts>
<original_user_goal>
{{goal_text}}
</original_user_goal>
Repair only these output issues if any: {{issues}}.

Write only {{document_path}} and {{destination}}. Use UTF-8. The recommendation should be 5–8 short lines: artifact path, existing execution/check entry, improvement comparison, explicit stopping condition (or open goal), permitted/forbidden changes, material uncertainty. Preserve the original goal and exact identifiers; refer to the frozen original goal instead of copying long specifications. Prefer existing tests/evaluators. State confirmed facts; preparation resolves implementation details after approval. No requirements/coverage/oracle reports, reviewer, extra Smoke, or architecture discussion. Functional baseline failures are allowed; preparation runs the actual bounded baseline after approval. Keep external verifiers outside Flywheel and private holdout evidence out of public feedback.

Write this JSON reference to {{destination}} with no other fields:
{"artifactPath":"project-relative artifact path from project facts","documentPath":"{{document_path}}","userFacingSummary":"Two or three short Chinese sentences confirming the user's goal, actual evaluation method, and necessary modification boundary."}
The summary asks for one brief confirmation. Then finish this turn immediately.
