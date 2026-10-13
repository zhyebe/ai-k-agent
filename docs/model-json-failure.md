# 模型决策 JSON 失败处理

桌面实时分析收到无效决策时，将原返回正文和具体格式错误发给同一个模型，保留原始行情、账户、策略、已审核 Skill，让模型返回完整纠正决策。程序不会补括号、猜交易字段或从多个冲突结果中选择一个。

每轮最多一次纠正请求，格式纠正和动作一致性纠正共用该次数。两次请求共用原超时和取消信号；退出、停止任务或达到原截止时间后不再请求或执行。输出额度耗尽、工具调用、内容过滤和空正文不触发格式纠正。

纠正后的正文必须是单个完整 JSON 对象，且 `action` 为 `BUY`、`SELL` 或 `HOLD`，再经过已有动作、概率及执行检查。纠正失败保持本轮分析失败，不执行残缺响应中的入场、离场或撤单。AI 请求继续在桌面端运行。

`decision.modelDiagnostics` 保存协议、停止原因、正文长度、SHA-256 和 `jsonError`；发生纠正时附带最多两次 `attempts`。`TRUNCATED_JSON`、`MULTIPLE_JSON_VALUES`、`MISMATCHED_JSON_BRACKETS`、`INVALID_JSON_SYNTAX`、`NON_OBJECT_JSON`、`NO_JSON_OBJECT` 和 `INVALID_DECISION_ACTION` 区分具体失败；纠正请求传输失败记录 `retryError: REQUEST_FAILED`。

任务的 `lastModelFailure` 保存最近一次格式失败的轮次、Provider、时间、是否恢复和精简诊断；后续成功轮次不会覆盖，重启后保留。只存诊断字段，不存原正文、推理或密钥。失败原正文仅在当轮交回原模型纠正。

2026-10-13 14:44:44 的截图只有通用错误，历史正文和详细失败诊断已不可取得，不能确定该次具体语法错误。自动纠正能恢复部分模型格式错误；仍不能保证模型每次都返回有效决策。
