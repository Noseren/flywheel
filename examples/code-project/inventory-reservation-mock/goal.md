改进 `src/reserve-inventory.js` 导出的 `reserveInventory(stock, requests)`，使批量库存预留具有确定、可审计且原子的行为。

`stock` 是以 SKU 为键、非负整数库存为值的普通对象；`requests` 是由 `{ sku, quantity }` 组成的数组。函数不得修改 `requests`。同一 SKU 的多条请求必须先按首次出现顺序合并，再统一校验可用库存。

成功时返回 `{ ok: true, stock, allocations }`：`stock` 是扣减后的新对象，输入 `stock` 保持不变；`allocations` 每个 SKU 只有一项，形状为 `{ sku, quantity }`，顺序为该 SKU 在请求中首次出现的顺序。

失败时返回 `{ ok: false, errors }`，不得返回部分 allocations，也不得修改输入库存。函数必须一次收集所有可确定的错误，并保持确定顺序：按请求首次出现顺序报告 SKU；同一 SKU 的请求格式错误按原请求顺序报告。错误字符串必须清楚包含相关 SKU。以下情况均为错误：SKU 为空或不是字符串、quantity 不是正整数、SKU 不存在、合并后的需求量超过库存。无效 quantity 不计入该 SKU 的合并需求量，但不阻止继续发现其他错误。

空 requests 是合法成功，返回内容相同的新库存对象和空 allocations。实现不得依赖第三方包。

只允许修改 `src/`。不得修改 `goal.md`、`test/` 或 `package.json`；不能删除、跳过或弱化公开测试。评价应运行 `npm test` 并检查实现清晰度。公开测试是完整功能清单，不要为了套模板隐藏其中一部分要求。
