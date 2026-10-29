修复 src/ 下订单履约的三个模块，使其满足 本文件的全部公开接口约定和 test/ 的全部检查：批量库存错误收集/重复合并/不修改输入；整数分金额与折扣边界；订单幂等、冲突检查和失败原子性。

只允许修改 src/，不得修改 goal.md、package.json、test/ 或 .flywheel 冻结资产。全部需求公开，使用当前 Node 运行 node --test test/*.test.js，无需安装依赖、网络或隐藏 verifier，不合成 train/holdout。库存与金额有独立边界，订单整合负责跨模块原子性；有具体证据和收益时可以有界协作，不要求每次都委派或审查。

这是确定性 Code Project；评价复用现有公开测试并保存真实输出，不需要任务模型或语义 judge。失败 baseline 可以建立 v1。候选比 baseline 通过更多检查且不回退已通过检查才 retain；所有检查通过表示 achieved。一次简要确认后自动完成准备、baseline、候选优化和固定评价。优化 Agent 不能改评价或自行宣称晋升。

## 库存接口

`planReservation(stock, lines)` 的 stock 是非负整数库存的普通对象，lines 是 `{ sku, quantity }` 数组。函数不能修改任何输入。quantity 必须是正的安全整数，sku 必须是非空字符串（不自动 trim 或变更大小写）。重复 SKU 按首次出现顺序合并。

- 成功：`{ ok: true, stock: 新对象, allocations: [{sku, quantity}] }`。每个 SKU 只有一个 allocation，空单返回新库存和空 allocations。
- 失败：`{ ok: false, errors }`，没有部分 stock 或 allocations。先按输入顺序收集格式错误 `{code:'invalid_sku'|'invalid_quantity', index}`；再按格式有效行中 SKU 首次出现顺序收集 `{code:'unknown_sku',sku}` 或 `{code:'insufficient_stock',sku}`。格式有效行指 SKU 与 quantity 均有效；无效数量不参与合并或决定顺序。SKU 只能匹配 stock 自有属性，不能匹配原型属性。输入数量及合并结果超出安全整数范围也属于 invalid_quantity；合并溢出报告触发溢出的行 index。

## 金额接口

`quoteOrder(catalog, allocations, options = {})`：catalog 自有 SKU 对应非负安全整数分价；allocation 的数量是正安全整数。options 的 discountBps 默认 0，必须为 0..10000 的整数；shippingCents 默认 0，必须为非负安全整数。不得修改输入。

返回 `{subtotalCents,discountCents,shippingCents,totalCents}`。逐项按整数分累加；折扣为 `floor(subtotalCents * discountBps / 10000)`，运费不参与折扣。空单运费为 0。中间应付金额及返回值必须保持安全整数精度，输入、SKU 或结果无效时抛出 RangeError。百分比乘法可用精确整数计算，不能因为可安全表示的最终折扣而丢失精度。

## 订单接口

`fulfillOrder(state, order)`：state 为 `{stock,catalog,completed}`，completed 初始为 `{}`；order 为 `{id,lines,options?}`。输入均不能被修改。

- id 必须是非空字符串。失败返回 `{ok:false,state:原对象,errors:[{code:'invalid_order_id'}]}`。
- 首次成功返回 `{ok:true,state:新对象,receipt,replayed:false}`。receipt 是 `{id,allocations,pricing}`；新 state 保留 catalog，并把已完成订单存入新的 completed 自有属性。内部缓存结构不限，但不得修改旧 receipt 或缓存。
- 相同 id、相同 lines 内容/顺序、相同规范化选项（缺失选项等价于默认值）重复提交，返回相同 receipt 内容及 `{ok:true,state:原对象,replayed:true}`，不再次扣库存。应在检查当前库存是否足够之前识别重复请求。
- 同 id 的 lines 或规范化选项不同，失败 errors 为 `[{code:'idempotency_conflict'}]`。
- 库存失败直接传递库存 errors，state 不变；金额计算失败返回 `[{code:'invalid_pricing'}]`，不能留下任何库存扣减或幂等记录。成功必须同时完成库存与订单记录；不能部分提交。
- id 与 SKU 即使是 `toString`、`constructor`、`__proto__` 也按普通字符串键处理，不能通过原型判断为已有记录。
