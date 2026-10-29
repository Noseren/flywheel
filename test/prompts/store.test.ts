import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PromptAssetStore, promptAsset } from "../../src/services/prompt/index.ts";

async function writeAsset(root: string, id: string, text: string): Promise<void> {
  const file = path.join(root, `${id.replaceAll(".", path.sep)}.md`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

test("prompt assets render nested requests and record hashes", async () => {
  const builtinRoot = await mkdtemp(path.join(os.tmpdir(), "flywheel-prompts-"));
  await writeAsset(builtinRoot, "inner.message", "Hello {{name}}");
  await writeAsset(builtinRoot, "outer.envelope", "<job>\n{{body}}\n</job>");
  const store = new PromptAssetStore({ builtinRoot });

  const result = await store.resolve(promptAsset("outer.envelope", {
    body: promptAsset("inner.message", { name: "Flywheel" }),
  }));

  assert.equal(result.text, "<job>\nHello Flywheel\n</job>");
  assert.deepEqual(result.assets.map((asset) => asset.id), ["outer.envelope", "inner.message"]);
  assert.ok(result.assets.every((asset) => asset.templateSha256.length === 64));
  assert.ok(result.assets.every((asset) => asset.renderedSha256.length === 64));
});

test("project prompts override configured and builtin assets", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "flywheel-project-prompts-"));
  const configuredRoot = await mkdtemp(path.join(os.tmpdir(), "flywheel-configured-prompts-"));
  const builtinRoot = await mkdtemp(path.join(os.tmpdir(), "flywheel-builtin-prompts-"));
  await writeAsset(builtinRoot, "run.task", "builtin");
  await writeAsset(configuredRoot, "run.task", "configured");
  await writeAsset(path.join(projectRoot, ".flywheel", "system-assets", "prompts"), "run.task", "project");
  const store = new PromptAssetStore({ projectRoot, configuredRoot, builtinRoot });

  const result = await store.resolve(promptAsset("run.task"));

  assert.equal(result.text, "project");
  assert.equal(result.assets[0].source, "project");
});

test("prompt assets fail closed on missing variables and recursion", async () => {
  const builtinRoot = await mkdtemp(path.join(os.tmpdir(), "flywheel-invalid-prompts-"));
  await writeAsset(builtinRoot, "missing.value", "{{required}}");
  await writeAsset(builtinRoot, "recursive.asset", "{{body}}");
  const store = new PromptAssetStore({ builtinRoot });

  await assert.rejects(store.resolve(promptAsset("missing.value")), /missing variable: required/);
  await assert.rejects(store.resolve(promptAsset("recursive.asset", {
    body: promptAsset("recursive.asset"),
  })), /Recursive prompt asset reference/);
});

test("materializeOverride creates an editable project copy", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "flywheel-override-project-"));
  const builtinRoot = await mkdtemp(path.join(os.tmpdir(), "flywheel-override-builtin-"));
  await writeAsset(builtinRoot, "run.task", "builtin {{value}}");
  const store = new PromptAssetStore({ projectRoot, builtinRoot });

  const destination = await store.materializeOverride("run.task");

  assert.equal(await readFile(destination, "utf8"), "builtin {{value}}");
  assert.equal((await store.inspect("run.task")).source, "project");
});

test("rubric evaluation is frozen in evaluate_guide and executed by Evaluate Agents", async () => {
  const store = new PromptAssetStore();
  const adapter = await store.inspect("adapter.codex.job");
  const manager = await store.inspect("common.manager-decision");
  const proposal = await store.inspect("init.proposal.schema");
  const contract = await store.inspect("init.contract.generate");
  const evaluatorBuilder = await store.inspect("init.evaluator.generate");
  const evaluatorRepair = await store.inspect("init.evaluator.repair");
  const evaluatorReview = await store.inspect("init.evaluator.review");
  const smoke = await store.inspect("init.smoke.validate");
  const tasking = await store.inspect("run.tasking.batch-generate");
  const evaluate = await store.inspect("run.evaluate.generate");

  assert.match(adapter.template, /Keep each command output below 32 KiB/);
  assert.match(adapter.template, /Caches, temporary files, lockfiles and test artifacts/);
  assert.match(adapter.template, /a line limit does not bound a giant line/);
  assert.match(manager.template, /超长日志\/单行 JSON 引发转录或解析失败/);
  assert.match(manager.template, /字节限幅读取.*获准时恢复原 operation\/session 重试一次/);
  assert.match(manager.template, /冻结边界变更或歧义优先于继续/);
  const conversation = await store.inspect("common.conversation-decision");
  assert.match(conversation.template, /追问\/歧义用 answer/);
  assert.match(conversation.template, /不把对象字段误解为优化流程要求/);
  assert.match(proposal.template, /每个维度分别写出评价对象、证据要求、每一个可取分值的独立评分细则/);
  assert.match(contract.template, /不生成 evaluator、测试样本、rubric 实现/);
  assert.match(contract.template, /`task\.md`.*逐字包含/);
  assert.match(evaluatorBuilder.template, /evaluate_guide\.md：每项 requirement 的评价对象、输入、证据、逐档 rubric/);
  assert.match(evaluatorBuilder.template, /语义评价逐维度给结果、证据、理由/);
  assert.match(evaluatorBuilder.template, /只代码化无歧义真值、计数或确定数值/);
  assert.match(evaluatorBuilder.template, /禁止用关键词、正则、模糊匹配或启发式代理自由文本语义/);
  assert.match(evaluatorRepair.template, /正常 Run 的全覆盖不能缩减为 Smoke 的一个代表单元/);
  assert.match(evaluatorRepair.template, /不得用关键词、正则或启发式语义代理/);
  assert.match(evaluatorReview.template, /不能只是给共享测试名追加 requirement id/);
  assert.match(evaluatorReview.template, /导入位置、调用方向、参数顺序/);
  assert.match(evaluatorReview.template, /不得读取或运行外部 benchmark verifier/);
  assert.match(smoke.template, /不执行正常 Run 全量样本\/套件、逐单元委派或完整 rubric/);
  assert.match(smoke.template, /不在 Smoke 代跑/);
  assert.match(smoke.template, /语义评分及反例留给正常 Evaluate/);
  assert.match(evaluate.template, /语义 rubric 由 Evaluate Agent 对全部实际样本逐维度执行/);
  assert.match(evaluate.template, /可复用项目根已安装的同一工具/);
  assert.match(tasking.template, /项目根目录的该工具/);
  assert.match(evaluate.template, /不能以关键词\/正则\/模糊匹配\/启发式代替语义判断/);
  assert.match(evaluate.template, /不得仅存机械结果就 completed/);
});

test("Init goal prompts preserve user intent and Smoke isolates one train record", async () => {
  const store = new PromptAssetStore();
  const explore = await store.inspect("init.explore.generate");
  const proposalSchema = await store.inspect("init.proposal.schema");
  const proposal = await store.inspect("init.proposal.generate");
  const contract = await store.inspect("init.contract.generate");
  const contractRepair = await store.inspect("init.contract.repair");
  const evaluatorBuilder = await store.inspect("init.evaluator.generate");
  const evaluatorBuilderRepair = await store.inspect("init.evaluator.repair");
  const evaluatorProjectNative = await store.inspect("init.evaluator.project-native");
  const evaluatorReview = await store.inspect("init.evaluator.review");
  const smoke = await store.inspect("init.smoke.validate");
  const smokeRepair = await store.inspect("init.smoke.repair");
  const tasking = await store.inspect("run.tasking.batch-generate");
  const taskingRepair = await store.inspect("run.tasking.batch-repair");
  const evaluate = await store.inspect("run.evaluate.generate");
  const evaluateRepair = await store.inspect("run.evaluate.repair");

  assert.match(explore.template, /\{\{user_goal\}\}/);
  assert.match(proposal.template, /用户目标是本次任务的权威需求/);
  assert.match(proposal.template, /普通功能需求和验收目标仍然是任务要求，但不是红线/);
  assert.match(proposal.template, /Select 只能根据证据完整性以及候选相对当前晋升版本的改进决定是否晋升/);
  assert.match(proposal.template, /普通功能失败是有效低分证据/);
  assert.match(proposal.template, /不得仅因测试可以枚举就合成 holdout/);
  assert.match(proposal.template, /有限公开规格.*candidate 模式/);
  assert.match(proposal.template, /分支、commit、snapshot、rollback 和版本晋升由 Runtime/);
  assert.match(proposal.template, /不得把分支名、用户仓库 commit 或 Git 工作树状态写成业务评分项/);
  assert.match(proposal.template, /不存在的解释器或工具也只能规划为条件证据/);
  assert.match(proposal.template, /未来 Run 才会产生的 Agent 轨迹/);
  assert.match(proposal.template, /不得仅凭包名、目录名或命令表面形式宣称它不会启动服务/);
  assert.match(proposalSchema.template, /sample 模式取 train 第一个逻辑位置/);
  assert.match(proposalSchema.template, /candidate 模式取两个 Guide 共同指定的最小公开检查/);
  assert.match(proposalSchema.template, /不得把多条正反例、完整 train\/holdout、全量测试或 evaluator 自检序列写成 Smoke/);
  assert.match(proposalSchema.template, /Smoke 不要求当前 baseline 通过目标功能断言/);
  assert.match(proposalSchema.template, /仍是有效低分基线/);
  assert.match(contract.template, /`task\.md`.*逐字包含.*全部用户原文/);
  assert.match(contract.template, /每一项可独立评价的公开 artifact\/输出要求拆成稳定、唯一的条目/);
  assert.match(contract.template, /不能只写一个笼统总项/);
  assert.match(contract.template, /不得加入外部最终 verifier 的隐藏要求/);
  assert.match(contract.template, /不得在编译时扩大已批准方案的晋级语义/);
  assert.match(contract.template, /必须逐字复制.*proposal_ref_path/);
  assert.match(contract.template, /普通功能和回归失败是有效低分证据/);
  assert.match(contract.template, /Tasking 只执行候选，不实现、不修复、不修改候选/);
  assert.match(contract.template, /artifact 的改变都由 Refine 负责/);
  assert.match(contract.template, /Tasking 的通用 JobResult 仍返回 `completed`/);
  assert.match(contract.template, /每一轮（包括续接旧 session）开始时都必须重新读取/);
  assert.match(contractRepair.template, /本轮必须实际重新读取/);
  assert.match(contractRepair.template, /当前文件内容是唯一权威版本/);
  assert.match(contractRepair.template, /不得生成 evaluator、测试样本/);
  assert.match(contractRepair.template, /不得在修复时扩大晋级语义/);
  assert.match(evaluatorReview.template, /checks 必须与 requirements\.json 一一对应/);
  assert.match(contractRepair.template, /artifact 改动只属于 Refine/);
  assert.match(contract.template, /Runtime 独占分支、commit、snapshot、rollback/);
  assert.match(contract.template, /不得拆成业务 requirements/);
  assert.match(contract.template, /缺少矩阵环境不是 Init 契约或 evaluator 生成失败/);
  assert.match(evaluatorBuilder.template, /自然样本分布使用唯一 `train`、`holdout` 成对资产/);
  assert.match(evaluatorBuilder.template, /不得因测试可枚举就合成 holdout/);
  assert.match(evaluatorBuilder.template, /每项公开要求必须在 Propose 可见的 train 证据中出现/);
  assert.match(evaluatorBuilder.template, /Code Project 优先生成项目原生测试框架可执行的独立测试文件/);
  assert.match(evaluatorBuilder.template, /\{\{project_native_strategy\}\}/);
  assert.match(evaluatorBuilderRepair.template, /\{\{project_native_strategy\}\}/);
  assert.match(evaluatorProjectNative.template, /必须在写最终评价资产前使用 AgentService 原生递归委派/);
  assert.match(evaluatorProjectNative.template, /按共享 API、fixture 和证据面划分为 2–6 个互不遗漏的功能簇/);
  assert.match(evaluatorProjectNative.template, /不要机械地每条 requirement 委派一个 Child/);
  assert.match(evaluatorProjectNative.template, /所有 requirement id 恰好由一个 bundle 拥有/);
  assert.match(evaluatorProjectNative.template, /实际 collection 得到的 node id/);
  assert.match(evaluatorProjectNative.template, /不能只执行代表性子集/);
  assert.match(evaluatorBuilder.template, /`__FLYWHEEL_CANDIDATE_ROOT__`/);
  assert.match(evaluatorBuilder.template, /`__FLYWHEEL_OUTPUT_DIR__`/);
  assert.match(evaluatorBuilder.template, /不得把 `.flywheel\/runtime\/outputs`.*写死/);
  assert.match(evaluatorBuilder.template, /output 位于候选内时按真实相对路径排除整个 output 子树/);
  assert.match(evaluatorBuilder.template, /output 位于候选外时不得把它作为候选输入遍历/);
  assert.match(evaluatorBuilder.template, /与隔离 candidate worktree 并列/);
  assert.match(evaluatorBuilder.template, /不得用候选镜像、包装脚本或预处理复制/);
  assert.match(evaluatorBuilder.template, /结构化 `unavailable` 证据和条件命令/);
  assert.match(evaluatorBuilder.template, /未来 Run 才产生的候选输出.*不可能成为 Init 自检前置条件/);
  assert.match(evaluatorBuilder.template, /不得只验证最显眼的 happy path/);
  assert.match(evaluatorBuilder.template, /恰好一个有界、无网络、无服务、无后台进程的 Init Smoke 单元/);
  assert.match(evaluatorBuilder.template, /对正常 Run 会调用的每类最终命令/);
  assert.match(evaluatorBuilder.template, /Windows 使用不会吞掉反斜杠、盘符或分隔符的表示/);
  assert.match(evaluatorBuilder.template, /至少一次必须走 normal full 分支/);
  assert.match(evaluatorBuilder.template, /逐项审计 coverage\.json/);
  assert.match(evaluatorBuilder.template, /运行时行为和声明式资产/);
  assert.match(evaluatorBuilder.template, /传统短路 law 代替新增累积分支/);
  assert.match(evaluatorBuilder.template, /只含一个 id 的 `requirementIds`/);
  assert.match(evaluatorBuilder.template, /不得给共享测试名追加 requirement id/);
  assert.match(evaluatorBuilderRepair.template, /正常 Run 的全覆盖不能缩减为 Smoke 的一个代表单元/);
  assert.match(evaluatorBuilderRepair.template, /传统但不适用的 law/);
  assert.match(evaluatorBuilderRepair.template, /不得让 snapshot 递归包含自身/);
  assert.match(evaluatorBuilderRepair.template, /不得写死 runtime、v1、Smoke、自检或绝对输出路径/);
  assert.match(evaluatorBuilderRepair.template, /重跑 normal full 分支、比较候选 fixture 前后变更/);
  assert.match(evaluatorReview.template, /写死 `.flywheel\/runtime\/outputs`.*必须 invalid/);
  assert.match(evaluatorReview.template, /Reviewer 必须真实执行两种拓扑/);
  assert.match(evaluatorReview.template, /至少运行一次 normal full 分支/);
  assert.match(evaluatorReview.template, /因反斜杠\/盘符解析在候选根生成拼接文件/);
  assert.match(evaluatorReview.template, /依赖 Tasking\/Smoke 先复制候选镜像.*必须 invalid/);
  assert.match(evaluatorReview.template, /不得仅因 Init 没有该工具判 invalid/);
  assert.match(evaluatorReview.template, /不能因看不到未来 Agent 轨迹拒绝评价器/);
  assert.match(evaluatorReview.template, /law 资产本身与具体实现的运行时行为分别审计/);
  assert.match(evaluatorReview.template, /不要求每条 requirement 拥有独立文件、runner 或 evaluator/);
  assert.match(evaluatorReview.template, /实际运行 framework collection/);
  assert.match(evaluatorReview.template, /完整冻结测试目录而非代表性子集/);
  assert.match(smoke.template, /执行范围固定为.*恰好一个代表性单元/);
  assert.match(smoke.template, /manifest 没有 train\/holdout.*candidate 最小公开检查/);
  assert.match(smoke.template, /两个 guide 必须指向 train 第一个逻辑位置的同一精确 id 或 locator/);
  assert.match(smoke.template, /不得读取、复制、执行或评价 manifest 中 id 为 `holdout`/);
  assert.match(smoke.template, /不得为它创建 Child Job/);
  assert.match(smoke.template, /不得用项目全量测试、服务启动、网络访问/);
  assert.match(smoke.template, /非零被测命令退出码或 evaluator 判定不通过，也可以是有效基线/);
  assert.match(smoke.template, /候选尚未实现约定入口、未产生必需输出、输出不可读或 evaluator 报告 `incomplete`/);
  assert.match(smoke.template, /不得先复制候选镜像、改用外置 output/);
  assert.match(smoke.template, /snapshot 排除了完整 output 子树且不会递归包含自身/);
  assert.match(smokeRepair.template, /sample 模式取 train 第一个逻辑位置，candidate 模式取一个有界最小公开检查/);
  assert.match(smokeRepair.template, /不得复制候选镜像、使用外置 output/);
  assert.match(smokeRepair.template, /正常 Run 的完整 rubric、全量覆盖和正式分数不适用于 Smoke/);
  assert.match(smokeRepair.template, /候选缺少约定入口、未生成必需输出、输出不可读或 evaluator 报告 `incomplete`/);
  assert.match(tasking.template, /这是正常 Run，不是 Init Smoke/);
  assert.match(tasking.template, /证据采集是 Tasking 自身的职责/);
  assert.match(tasking.template, /完整候选工作区.*不能用 artifact 子路径代替/);
  assert.match(tasking.template, /`collector` 只是现有 manifest 的兼容角色名/);
  assert.match(tasking.template, /本轮不得再执行、投影或生成该 smoke 输入/);
  assert.match(tasking.template, /只表示 Tasking 证据采集协议是否完成/);
  assert.match(tasking.template, /不得把这些候选结果写成 Tasking 的 `failed`/);
  assert.match(taskingRepair.template, /不得在修复中执行、投影或补生/);
  assert.match(evaluate.template, /这是正常 Run，不是 Init Smoke/);
  assert.match(evaluate.template, /候选缺少入口、输出或证据.*Child JobResult 必须为 `completed`/s);
  assert.match(evaluateRepair.template, /不得在修复中执行、投影或补生/);
});

test("evaluation prompts forbid explicit and configured auto-fixes before execution", async () => {
  const store = new PromptAssetStore();
  for (const id of ["init.evaluator.generate", "init.evaluator.repair", "init.evaluator.review", "run.evaluate.generate"]) {
    const { template } = await store.inspect(id);
    assert.match(template, /禁止使用任何自动修复/, id);
    assert.match(template, /隐式自动修复开关/, id);
    assert.match(template, /fix = true/, id);
    assert.match(template, /--no-fix/, id);
    assert.match(template, /--write.*--update-snapshots/, id);
    assert.match(template, /不得执行后再回滚/, id);
  }
  const { template: child } = await store.inspect("init.evaluator.project-native");
  assert.match(child, /只读约束完整传给每个 Child/);
  assert.match(child, /ruff check --no-fix/);
  const { template: review } = await store.inspect("init.evaluator.review");
  assert.match(review, /不得为了验证而运行危险命令/);
  assert.match(review, /交回 Builder 修复，不得 accepted/);

  // Run protocol repairs embed the original evaluation prompt, including its safety boundary.
  const { template: evaluate } = await store.inspect("run.evaluate.generate");
  const variables = Object.fromEntries([...evaluate.matchAll(/\{\{(\w+)\}\}/g)]
    .map((match) => [match[1], `/fixture/${match[1]}`]));
  const repaired = await store.resolve(promptAsset("run.evaluate.repair", {
    issues: "protocol error", report_path: "/fixture/report", result_path: "/fixture/result",
    base_prompt: promptAsset("run.evaluate.generate", variables),
  }));
  assert.match(repaired.text, /禁止使用任何自动修复/);
  assert.match(repaired.text, /停止调用并返回 `failed`/);
  assert.match(repaired.text, /不得自行修改冻结评价器、执行计划、参数或项目配置/);
});

test("delegated domain artifacts use explicit contracts and selective retries", async () => {
  const store = new PromptAssetStore();
  const delegation = await store.inspect("common.delegation-capable");
  const resume = await store.inspect("common.delegation-resume");
  const evaluate = await store.inspect("run.evaluate.generate");

  assert.match(delegation.template, /精确输出契约/);
  assert.match(delegation.template, /禁止只写“按 Guide”“按规定格式”“返回完整字段”/);
  assert.match(delegation.template, /不得重新运行已经合格的执行单元/);
  assert.match(delegation.template, /逐一确认每个 `inputs` 路径真实存在/);
  assert.match(delegation.template, /不得猜测惯例文件名、使用通配路径/);
  assert.match(resume.template, /合格 artifact 必须保留并直接用于聚合/);
  assert.match(resume.template, /只能包含 `failed`、`aborted`、`needs_input`/);
  assert.match(evaluate.template, /rubric 细则、输入边界和精确输出 Schema/);
  assert.match(evaluate.template, /不得因为部分样本失败而整批重跑/);
});

test("same-version search combines complementary train-validated candidates before promotion", async () => {
  const store = new PromptAssetStore();
  const select = await store.inspect("run.refine.select");
  const refine = await store.inspect("run.refine.worktree");
  const propose = await store.inspect("run.propose.generate");
  const assess = await store.inspect("run.assess-target.generate");

  assert.match(select.template, /至少两个候选都有明确的 train 改进证据/);
  assert.match(select.template, /必须返回 `iterate`/);
  assert.match(select.template, /组合必须成为下一轮新假设/);
  assert.match(select.template, /建议阈值.*不能自行升级成硬门槛/);
  assert.match(select.template, /相对当前正式版本有可信改进/);
  assert.match(select.template, /普通功能目标使用“必须”“应当”或 required 等措辞/);
  assert.match(select.template, /当前正式版本的 train 证据/);
  assert.match(select.template, /没有满分.*eligibility\/gate 标签.*没有改进/);
  assert.match(select.template, /不得仅因仍有普通功能样本失败而要求它一次达到最终目标/);
  assert.match(propose.template, /本轮至少提出一个明确的组合假设/);
  assert.match(propose.template, /所组合的原候选 id/);
  assert.match(propose.template, /Refine 必须在当前 base 上重新实现/);
  assert.match(propose.template, /假设规模由任务和当前缺口决定，不等于“小 diff”/);
  assert.match(propose.template, /不得仅因实现范围较大就返回 `exhausted`/);
  assert.match(propose.template, /目标是否达成已经由独立 Target Assess/);
  assert.match(propose.template, /不能返回完成结论/);
  assert.match(propose.template, /不能读取它的详细报告/);
  assert.match(assess.template, /不提出下一轮假设、实现建议或修改方向/);
  assert.match(assess.template, /holdout 中任何与目标相关的完整失败/);
  assert.match(assess.template, /candidate 模式可以由覆盖全部公开要求的完整评价证明目标/);
  assert.match(propose.template, /不得把冻结 evaluator、Tasking\/Evaluate 的完整覆盖矩阵/);
  assert.match(propose.template, /复杂覆盖仍由既有 Tasking 和 Evaluate 执行/);
  assert.match(propose.template, /Candidate Validate 仅因评价基础设施、委派协议或评价产物不完整而失败/);
  assert.match(propose.template, /明确区分“尚未验证”和“已被证伪”/);
  assert.match(propose.template, /`request_changes` 只证明当前实现尚不能进入 Validate/);
  assert.match(propose.template, /修复预算耗尽也只结束当前候选的修复，不等于耗尽后续搜索/);
  assert.match(refine.template, /所有明确的实现项、测试项和完成条件/);
  assert.match(refine.template, /不能只完成最显眼的生产代码后把其余条件留给 Review 发现/);
  assert.match(refine.template, /使用 Child Agent 分别产出边界明确的补丁或材料/);
});
