# Axiom Agent v1.0

Axiom 是 macOS / Windows 单机工作流 Agent。安装后直接进入工作台，无需注册、登录、账号开通或部署服务器。配置 AI 接口地址、模型和 API Key，即可创建任务，连接目标网站或桌面 App，读取数据并分析。

任务、Provider、经验与目标网站凭据保存在本机。运行引擎随应用启动、随应用退出；无需另装 Node.js、MySQL、MongoDB 或 Docker。访问行情网站、在线 AI 和 GitHub 更新仍需网络；打开工作台和编辑本机配置不依赖外部服务。

## 使用

1. 打开应用，点击「配置 AI」，填写接口地址、模型、协议和 API Key。
2. 在「连接器」中点击「验证」，确认模型可用。
3. 新建任务，填写目标网站或 App；目标网站自身要求的账号仍需在目标页面登录或配置本机凭据。
4. 选择模型，开始观察或分析。任务模式决定是否执行实盘动作。

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

保留既有交易规则：AI 明确决定买多或买空，方向盈利概率至少 40% 才具备入场条件，达标不强制下单；单笔数量由任务配置。持仓或当前委托未清零时不开第二轮。

离场读取「持仓汇总」，按商品和方向整行操作。多单点差为 bid−订立均价，空单为订立均价−ask，不乘数量。盈利 ≥1 点立即整行转让，不等待 AI；亏损 ≤−2 点先连续观察 30 秒排查闪 K，再请求 AI 判断离场或继续持仓。实际持仓及委托清零后开始下一轮。

观察和影子模式不提交实盘；实盘模式保留手动或自动入场、自动离场。关闭应用停止本机运行，不自动平仓。详细规则见 [交易流程与汇总离场](docs/summary-exit-policy.md)。

安装与数据路径见 [安装说明](docs/install.md)，变更见 [v1.0.1 发布说明](docs/release-v1.0.1.md)。仓库保留的后台、数据库适配器和部署脚本用于 v0.3 历史维护，不属于 v1.0 桌面交付流程。
