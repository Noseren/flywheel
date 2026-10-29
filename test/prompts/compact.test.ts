import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PromptAssetStore, promptAsset } from "../../src/services/prompt/index.ts";

test("all builtin prompts preserve their input contracts and render without missing variables", async () => {
  const contracts = JSON.parse(await readFile(new URL("./template-contracts.json", import.meta.url), "utf8")) as Record<string, string[]>;
  const store = new PromptAssetStore();
  await store.validateAll();
  const assets = await store.list();
  assert.deepEqual(assets.map(a => a.id).sort(), Object.keys(contracts).sort());
  for (const asset of assets) {
    const keys = [...new Set([...asset.template.matchAll(/{{(\w+)}}/g)].map(m => m[1]))].sort();
    assert.deepEqual(keys, contracts[asset.id], asset.id);
    const variables = Object.fromEntries(keys.map(key => [key, `fixture:${key}`]));
    const rendered = await store.resolve(promptAsset(asset.id, variables));
    assert.doesNotMatch(rendered.text, /{{\w+}}/, asset.id);
    for (const key of keys) assert.ok(rendered.text.includes(`fixture:${key}`), `${asset.id}: ${key}`);
  }
});

test("compact preparation specifies normalized comparison evidence and accepts promoted candidate baselines", async () => {
  const prompt = await new PromptAssetStore().inspect("init.compact.prepare");
  assert.match(prompt.template, /path\.resolve\(path\.dirname\(baselineResultPath\), entry\)/);
  assert.match(prompt.template, /不能仅接受绝对路径/);
  assert.match(prompt.template, /不可要求历史报告 mode === 'baseline'/);
  assert.match(prompt.template, /summary 必须非空且最多 2000/);
  assert.match(prompt.template, /publicFeedback 最多 12000/);
  assert.match(prompt.template, /完整编译错误、测试输出和堆栈保存到 evidence 文件/);
});

test("preparation delegates actual execution to Runtime without treating its sandbox as a dependency probe", async () => {
  const store = new PromptAssetStore();
  const { template } = await store.inspect("init.compact.prepare");
  assert.match(template, /不运行项目检查、evaluator、依赖探针/);
  assert.match(template, /ProcessService 执行/);
  assert.match(template, /不能据此返回 failed\/needs_input/);
  assert.match(template, /completed 只表示评价草稿已写好/);
  const optimizer = await store.inspect("run.compact.optimize");
  assert.match(optimizer.template, /未完成试跑/);
  assert.match(optimizer.template, /不能跳过必要评价后晋升/);
});

test("compact preparation can investigate concrete coverage gaps before freezing without mandatory reviewers", async () => {
  const store = new PromptAssetStore();
  const prepare = (await store.inspect("init.compact.prepare")).template;
  assert.match(prepare, /明确指定的请求文件也是允许的协议输出/);
  assert.match(prepare, /复用前必须阅读原始目标和真实断言/);
  assert.match(prepare, /未冻结草稿的可补齐缺口由你处理/);
  assert.match(prepare, /不能强制新增 Reviewer/);
  assert.match(prepare, /不得以退出码0或所有现有测试绿色取代完整目标/);
  assert.doesNotMatch(prepare, /不得增加额外模型环节/);
  const assistance = (await store.inspect("common.assistance-capable")).template;
  assert.match(assistance, /check 不要求已有失败/);
  assert.match(assistance, /purpose:"check"/);
  assert.match(assistance, /已冻结评价遗漏才报告需要重新准备/);
  const resume = (await store.inspect("common.assistance-resume")).template;
  assert.match(resume, /核对指出的原始要求、检查断言和反例/);
  assert.match(resume, /不能把 Child 自报通过当作执行证据/);
});

test("prompt discovery ignores AppleDouble metadata, not real markdown assets", async () => {
  const builtinRoot = await mkdtemp(path.join(os.tmpdir(), "flywheel-prompt-metadata-"));
  await writeFile(path.join(builtinRoot, "._job.md"), Buffer.from([0, 5, 22, 7]));
  await writeFile(path.join(builtinRoot, "job.md"), "{{input}}");
  const store = new PromptAssetStore({ builtinRoot });
  await store.validateAll();
  assert.deepEqual((await store.list()).map(a => a.id), ["job"]);
});

test("compact tasking and judging render distinct frozen guides and outputs while optimizer receives public scope", async () => {
  const store = new PromptAssetStore();
  const shared = {
    subject_root: "/fixture/candidate", artifact_path: "/fixture/candidate/answer.txt",
    goal_path: "/fixture/.flywheel/goal.md", task_path: "/fixture/.flywheel/contract/task.md",
    train_path: "(none)", holdout_path: "(none)", outputs_dir: "/fixture/verification/outputs",
  };
  const tasking = await store.resolve(promptAsset("compact.tasking", { ...shared,
    guide_path: "/fixture/tasking-guide.md", result_path: "/fixture/verification/outputs/job-result.json" }));
  const judging = await store.resolve(promptAsset("compact.judging", { ...shared,
    guide_path: "/fixture/evaluation-guide.md", judge_result_path: "/fixture/verification/judging/judge.json",
    result_path: "/fixture/verification/judging/job-result.json" }));
  assert.ok(tasking.text.includes("/fixture/tasking-guide.md"));
  assert.ok(tasking.text.includes("/fixture/verification/outputs/job-result.json"));
  assert.match(tasking.text, /Do not optimize or grade the artifact/);
  assert.ok(judging.text.includes("/fixture/evaluation-guide.md"));
  assert.ok(judging.text.includes("/fixture/verification/judging/judge.json"));
  assert.ok(judging.text.includes("/fixture/verification/judging/job-result.json"));
  assert.match(judging.text, /fixed evaluator program owns final retention and target verdicts/);
  await assert.rejects(store.resolve(promptAsset("compact.judging", { ...shared,
    guide_path: "/fixture/evaluation-guide.md", result_path: "/fixture/verification/judging/job-result.json" })), /missing variable: judge_result_path/);
  const scope = { primary: ["answer.txt"], forbidden: [".flywheel/**"] };
  const optimizer = await store.resolve(promptAsset("run.compact.optimize", {
    context_path: "/fixture/attempt/context.md", worktree_path: shared.subject_root, change_scope: scope,
    assistance_guidance: "No delegation for this historical task.",
  }));
  assert.ok(optimizer.text.includes("/fixture/attempt/context.md"));
  assert.ok(optimizer.text.includes(shared.subject_root));
  assert.ok(optimizer.text.includes(JSON.stringify(scope)));
  assert.match(optimizer.text, /不得修改目标、评价器或评价方式/);
});

test("Select delegates final goal assessment to Target Assess, not Propose", async () => {
  const { template } = await new PromptAssetStore().inspect("run.refine.select");
  assert.match(template, /独立 Target Assess/);
  assert.doesNotMatch(template, /(?:由|让)[^。\n]*Propose[^。\n]*判断[^。\n]*目标|目标[^。\n]*由[^。\n]*Propose[^。\n]*判断/);
});

test("Tasking uses the whole candidate workspace, including when reusing a tool", async () => {
  const { template } = await new PromptAssetStore().inspect("run.tasking.batch-generate");
  assert.match(template, /源码、配置、测试目标和工作目录.*完整候选工作区 {{subject_root}}/);
  assert.doesNotMatch(template, /工作目录仍必须明确指向 {{artifact_path}}/);
});

test("Contract compilation cannot use proposal edits to overwrite the frozen goal", async () => {
  const { template } = await new PromptAssetStore().inspect("init.contract.generate");
  assert.match(template, /不得覆盖冻结目标/);
  assert.match(template, /发现冲突返回 failed/);
  assert.match(template, /评价系统自身必须遵守.*不得拆成.*业务 requirements/);
  assert.doesNotMatch(template, /只有方案中的明确修改才可覆盖原始目标/);
});

test("Contract and Evaluator distinguish stage-local duties from frozen candidate boundaries", async () => {
  const store = new PromptAssetStore();
  assert.match((await store.inspect("init.contract.generate")).template, /阶段职责.*不是候选业务要求/);
  assert.match((await store.inspect("init.contract.generate")).template, /后续已授权的 Evaluator Builder/);
  assert.match((await store.inspect("init.evaluator.generate")).template, /只限制上一阶段/);
  assert.match((await store.inspect("init.evaluator.generate")).template, /不得据此忽略用户的跨阶段禁令/);
  assert.match((await store.inspect("init.evaluator.repair")).template, /只限制上一阶段/);
  assert.match((await store.inspect("init.evaluator.repair")).template, /不得据此忽略用户的跨阶段禁令/);
  assert.match((await store.inspect("init.evaluator.repair")).template, /不把上一轮自己的失败结论当成契约原文/);
  for (const id of ["init.evaluator.generate", "init.evaluator.repair", "init.evaluator.review"]) {
    const { template } = await store.inspect(id);
    assert.match(template, /Child Job 本身就是实际模型能力/);
    assert.match(template, /硬编码全部 unavailable/);
    assert.match(template, /合成 fixture/);
  }
  for (const id of ["init.smoke.validate", "init.smoke.repair"]) {
    const { template } = await store.inspect(id);
    assert.match(template, /本身就是可用模型执行能力/);
    assert.match(template, /硬编码 unavailable/);
    assert.match(template, /采集链路缺陷/);
  }
});
