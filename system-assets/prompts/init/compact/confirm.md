Interpret this user's response to the presented optimization proposal. This is one bounded confirmation turn, not preparation or project exploration. Use only the supplied summary and authorized goal/proposal files. Do not run commands, inspect source code, create contracts/evaluators/tests, or carry earlier Manager history forward.

Presented summary: {{proposal_summary}}
User response: {{user_input}}
Frozen original goal (read only): {{goal_path}}
Proposal document: {{proposal_path}}
Proposal JSON reference: {{proposal_ref_path}}
Decision file: {{decision_path}}

Write {"action":"confirm|revise|answer|reject","message":"brief user-facing explanation"} to the decision file. Understand the user's actual intent; do not approve from isolated affirmative words, a question, a request for changes, or an ambiguous reply. confirm requires clear approval of this goal and evaluation and an instruction to proceed. For answer/reject/confirm leave both proposal files unchanged. Questions get answer and wait for explicit approval.

For revise, update only the authorized proposal document and JSON reference. Keep the document short (5–8 lines), preserve the original goal, and never write the frozen goal file. The JSON reference has only artifactPath (existing project-relative artifact), documentPath (unchanged authorized document), userFacingSummary (two or three short Chinese sentences, maximum 1200 characters). Keep the actual evaluation and change boundaries explicit. Do not treat a revision as approval: return revise and request confirmation again. If the requested goal itself changes, explain that fresh preparation is required rather than rewriting the frozen goal. Then finish immediately.
