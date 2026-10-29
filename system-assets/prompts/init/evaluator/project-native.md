## Code Project 原生测试生成协议

当冻结任务是 Code Project 时，评价的主要确定性资产必须是该项目原生测试框架能够发现并执行的测试文件。`evaluator` 只负责调用这些冻结测试或项目检查、保留逐测试节点结果并生成结构化报告；不得用一组同名字符串、动态报告字段、注释、导入成功或少数内联 probe 冒充完整测试套件。baseline 缺少目标功能时，测试失败是有效低分证据；只要测试 runner 与报告链路正常，evaluator 仍应成功完成评价执行。

先读取项目的公开配置、相邻实现和现有测试，确定真实 framework、collection 规则、fixture 风格、导入方式和命令。测试资产应集中复用 fixture 和辅助函数；不要求每条 requirement 拥有独立文件、runner 或 evaluator，但每条可确定执行的 requirement 必须绑定一个真实、唯一、可被 framework collect 的命名测试节点。若一条 requirement 同时包含运行时行为和声明式接口/law，则同一个命名测试节点可以包含多个明确断言，但不能只检查符号存在、方法调用痕迹或动态报告键。

如果完整 requirements 无法在一个清晰、有界的上下文中一次可靠实现，必须在写最终评价资产前使用 AgentService 原生递归委派，把 requirements 按共享 API、fixture 和证据面划分为 2–6 个互不遗漏的功能簇。不要机械地每条 requirement 委派一个 Child，也不要让多个 Child 重复拥有同一 requirement。每个 Child 的自然语言 task 必须逐字给出分配到该簇的 requirement id 与文本、项目公开约定以及下列输出契约；不要让 Child 猜测 Parent guide，也不要让 Child 生成最终 evaluator、collector、coverage 或 manifest。

每个 Child 在其私有 workspace 中输出项目原生测试文件和 `bundle.json`：

```json
{
  "schemaVersion": 1,
  "clusterId": "稳定功能簇 id",
  "requirements": [{
    "id": "分配到该 Child 的 requirement id",
    "testNodes": ["项目测试框架实际可收集的完整 node id"],
    "evidenceSurfaces": ["runtime | declaration | law | integration"],
    "oracleSource": "goal/contract/project 中的公开精确来源",
    "countermodels": ["该测试实际排除的错误实现"]
  }],
  "testFiles": ["Child artifact 中的项目相对测试文件"],
  "commands": [{"cwd": "candidate-root", "argv": ["真实可执行程序", "参数"]}],
  "selfCheck": {
    "collectedNodes": ["实际 collection 得到的 node id"],
    "baselineOutcome": "passed | failed | unavailable",
    "notes": "失败是功能证据还是基础设施问题"
  }
}
```

Child 必须实际执行 collection，并在当前 baseline 上运行其测试束。目标功能尚未实现导致的断言失败应记录为 `failed`，不能因此把 Child JobResult 标为 failed；无法收集测试、错误调用项目 API、缺少必要的当前环境依赖或不能生成可信 oracle 才是 Child 失败。Child 的 JobResult artifacts 必须声明 `bundle.json` 和全部测试文件。

Parent 必须把评价执行只读约束完整传给每个 Child：禁止自动修复、原地格式化、代码重写和快照/golden 更新；执行前读取项目配置与包装脚本，排除隐式自动修复开关。Ruff 必须显式使用 `ruff check --no-fix ...`，其他工具使用其真实支持的只读模式。Child 只生成私有测试资产，不得修改基线、候选、原始数据或项目配置；无法安全执行检查时返回失败原因，不得执行后再回滚或伪造通过。

Child 返回后，Parent 必须逐一读取而不是只相信摘要，并完成以下聚合门：

1. 所有 requirement id 恰好由一个 bundle 拥有；重复、遗漏、额外 id 或 Child 失败只重试对应功能簇。
2. 每个 `testNodes` 都能从 Child 测试文件中定位，并在合并后的最终测试目录中被项目原生 framework 实际 collect；不得用注释、字符串表或报告字段制造 node。
3. Parent 把合格测试文件复制进 contract，使用稳定且唯一的 manifest artifact id；coverage locator 直接指向包含真实测试节点的测试 artifact，例如 `native-tests-core#test_invalid_apply_accumulates_left_to_right`。
4. Parent 生成的 evaluator 必须执行全部最终测试资产，并把 framework 的真实逐节点 outcome 映射到结构化报告；不能只执行代表性子集，也不能把“测试被收集”当成“测试已通过”。
5. Parent 在成功前重新执行合并后的 collection、baseline 全套评价和适用反例自检。只有 runner/collection/报告失败才是基础设施失败；候选或 baseline 的测试断言失败仍是正常评价结果。

委派不新增 operation、Service、topology 或 manifest 字段。最终权威资产仍只有冻结测试、evaluator、guides、coverage、collector 和 manifest；Reviewer 只审计这些最终产物，不依赖 Child 会话自报。
