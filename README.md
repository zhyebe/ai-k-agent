# Axiom Agent v1.0

Axiom 是 macOS / Windows 单机工作流 Agent。安装后直接进入工作台。交易任务使用本机算法预测入场和离场。

任务、Provider、经验与目标网站凭据保存在本机。运行引擎随应用启动、随应用退出；无需另装 Node.js、MySQL、MongoDB 或 Docker。访问行情网站、在线 AI 和 GitHub 更新仍需网络；打开工作台和编辑本机配置不依赖外部服务。

## 使用

1. 新建任务并填写目标网站。目标网站账号可在目标页面登录或配置本机凭据。
2. 新任务默认使用影子记录，点击「开始观察」即可运行算法。
3. 实盘任务点击「开始自动交易」。入场、止盈和止损自动提交，交易网页的普通确认由程序处理。

Axiom 本身没有登录、注册、授权码或管理后台。已保存的 AI 配置与模型选择重启后保留。

## 开发

需要 Node.js 20+。无需复制 `.env` 或启动数据库。

```bash
npm install
npm run dev
```

开发命令启动 Vite 与 Electron；本机引擎由 Electron 自动管理。仅打开浏览器开发地址不会创建单机工作区。

运行构建后的桌面界面：

```bash
npm start
```

检查与打包：

```bash
npm run check
npm test
npm run test:standalone
npm run dist:mac
npm run dist:win
```

`test:standalone` 包含本机存储与运行引擎测试，以及真实 Electron 的免登录启动、AI 配置、模型调用和重启恢复检查；运行前需 `npm run build`，并具备桌面显示环境。

## 本机数据

数据位于 Electron `userData` 下的 `standalone` 目录：

- `workspace.json`：任务、AI Provider、经验、最近订单与事件。
- `.axiom-secret`：首次启动生成的本机加密密钥。
- `credentials.vault.json`：加密的目标网站凭据。

API Key 与目标网站密码使用 AES-256-GCM 加密，界面只显示脱敏信息。备份或迁移时，退出应用后整体复制数据目录，必须保留 `.axiom-secret`。浏览器登录状态位于 `userData/browser-profiles`；模型选择保存在应用本地存储。

数据通过串行写入、文件同步和原子替换保存。读写失败明确报错，不会切换成内存数据或演示仓储。重启后任务暂停，确认行情及持仓后再主动启动。

v1.0 使用独立本机工作区，不自动下载 v0.3 服务端的数据，也不沿用旧服务器地址、登录令牌或数据库环境配置。旧服务端数据保持原样；需要的 AI 配置在本机重新填写，经验可通过「导入经验」添加。

## AI 与经验

支持 OpenAI Compatible / Chat Completions、Responses、Anthropic 和 Gemini。模型验证、模型列表及分析请求由桌面直接发往配置的 AI 服务。

首次启动内置交易 Skill。可导入 Markdown / TXT / JSON，或粘贴专家经验；审核后的完整内容随行情交给 AI。删除的内置 Skill 不会在重启时自动恢复。

## 交易行为

本机算法按已结束的分钟 K 识别短线方向，上涨在相对低位入场，下跌在相对高位入场。相似历史路径用于估算入场区间、离场目标和预计到达时间。单笔数量由任务配置。持仓和委托清零后进入下一轮。

成交后按商品和方向监控持仓汇总。新定 K 更新止盈目标，盘口到价即离场。预计亏损时寻找可达的减亏价，最多观察两根 K。新定 K 明显否定回弹时提前止损，原止损和持仓期限继续生效。上下都没有影线的闪 K 期间等待，恢复正常定价后按最新盘口重判进出场。

同时持有多空时，合计价差为正就全平。合计未盈利时先退出亏损侧，确认成交后盈利侧最多观察 60 秒。到目标、利润回落或到时自动离场。

已提交和结果未知的订单先对账，再决定下一步。重启后任务暂停，保留原运行模式。

### 本机算法回放

```bash
node scripts/replay-algorithm.mjs order-book.jsonl 1
node scripts/replay-algorithm.mjs --candles minutes.jsonl 1
```

- 盘口文件每行是一份同品种 `MarketSnapshot`，含严格递增的 `observedAt`、品种标识、买卖盘深度，以及 `timeframes["1m"].history` 或 `timeframe: "1m"` 下的 `history`。当前 K 保留真实观测的 `confirmation`。回放用后续快照的可成交报价模拟入场，按对应买卖方向的深度与汇总离场规则计算结果。
- 分钟 K 文件每行包含品种标识、起始毫秒 `timestamp` 和 `open`、`high`、`low`、`close`。用已结束 K 生成信号，下一根连续 K 的开盘价模拟入场，带影线 K 的收盘价检查离场。该口径缺少买卖盘、盘中连续止损观测和实际成本，适合筛选待验证的策略。
- 对照总盈利、总亏损、盈利因子与已平仓回撤。盘口回放在每次模拟成交都有实测 `executionCostPoints` 时额外输出净收益，成本字段只用于回放统计。剩余持仓单列，保留独立时段验证。

安装与数据路径见 [安装说明](docs/install.md)，变更见 [v1.0.16 发布说明](docs/release-v1.0.16.md)。仓库的后台、数据库适配器和部署脚本用于 v0.3 历史维护。
