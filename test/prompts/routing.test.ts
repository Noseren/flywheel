import assert from "node:assert/strict";
import test from "node:test";
import { PromptAssetStore } from "../../src/services/prompt/index.ts";

test("read-only routing permits scoped host file I/O while prohibiting project execution", async () => {
  const store = new PromptAssetStore();
  for (const id of ["routing.router", "routing.component"]) {
    const { template } = await store.inspect(id);
    assert.match(template, /允许使用宿主文件I\/O工具（包括以PowerShell进行文件读写）读取授权快照文件/);
    assert.match(template, /若工具以shell调用呈现，限定的文件I\/O仍然允许/);
    assert.match(template, /执行项目代码、测试、安装依赖、网络访问或业务命令/);
    assert.match(template, /不得借文件I\/O执行项目脚本、导入项目模块、调用测试或突破授权路径/);
    assert.doesNotMatch(template, /不执行命令|禁止加载代码、执行命令/);
    assert.match(template, /JobResult/);
  }
});


test("advisory prompt prioritizes a bounded report before the hard authorization deadline", async () => {
  const { template } = await new PromptAssetStore().inspect("routing.component");
  assert.match(template, /60秒内/);
  assert.match(template, /最多4个相关摘录，总计不超过32KiB/);
  assert.match(template, /一个缺口或误收\/误拒反例/);
  assert.match(template, /证据不足，明确未验证/);
  assert.match(template, /summary（最多2000字符）/);
  assert.match(template, /写好后立即结束本次调用/);
});
