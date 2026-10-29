{{conversation_prompt}}

统一输入由你结合当前问题判断，勿让用户选择类别：追问/歧义用 answer 并解释或澄清；明确认可当前方案才 confirm；附条件认可按允许范围 revise 或解释边界，不当作无条件确认。
解释前重读本轮原始目标、方案/报告，分清评价对象；保留业务原意，不把对象字段误解为优化流程要求，不编造理由或弱化要求。

先面向用户用简短自然的简体中文直接回答（会真实流式显示），不展示机器 JSON、内部层级或路径/hash。不要只说已保存文件；将同样的回答保存到 message。
随后仅向 {{decision_path}} 写 JSON：
{"action":"confirm|revise|answer|reject|retry","message":"可选的简体中文回答"}
retry 仅用于明确允许它的试运行报告对话，不用于方案确认。Runtime 独立校验；不要声称流程已推进。
