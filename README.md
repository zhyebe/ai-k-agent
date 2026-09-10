# Axiom Agent

Axiom 是一个面向网站与桌面 App 的工作流 Agent。用户在桌面端创建任务，连接目标、托管账号、读取历史数据、分析趋势，再把结构化买卖意图交给有序规则链。规则可以自动裁决、要求人工处理，或直接触发停止与人工接管。

目标接入支持两种入口：网站填写 URL，桌面 App 填安装路径。系统可先自动发现目标档案和只读能力，再进入登录、历史数据采集、趋势追踪、规则裁决和动作执行链。真实网站/App 仍需对应 Connector Adapter 提供字段与动作映射，适配器版本需要审核。

用户端使用 Electron，覆盖 macOS 和 Windows。后台管理账号使用浏览器访问独立的 B/S 页面，只负责桌面端账号、密码、任务分配和审计日志；连接器、Provider、Skills 与分析工作流属于用户端。

## 本地启动

```bash
npm install
cp .env.example .env
npm run dev
```

打开用户端：`http://127.0.0.1:5173/`

打开后台：`http://127.0.0.1:5173/admin.html`

启动 Electron 用户端：

```bash
npm run dev:desktop
```

`npm run dev` 同时启动 Vite（5173）与 Node API（8787）。未配置数据库时使用内存演示仓储，页面仍可操作；服务端状态重启后会重置为演示数据。复制 `.env.example` 后请至少替换 `ADMIN_PASSWORD`、`APP_SECRET` 和 `DESKTOP_PASSWORD`。桌面端必须登录；若配置了 `DESKTOP_USERNAME` / `DESKTOP_PASSWORD`，首次启动会创建该用户并分配已有任务。

当前版本默认只给出买卖建议，不会自动下单。生产部署见 [docs/deploy.md](docs/deploy.md)，本地安装与试运行见 [docs/install.md](docs/install.md)。

「开始观察」启动的是服务端持续控制循环：首轮立即执行，之后按周期读取网页和只读行情。每轮都保留配置周期的历史 K 线、逐笔、页面字段和账户只读字段；规范化行情未变化时跳过 AI，变化、首轮或上轮失败时开启新的分析轮次，并把最近轮次作为多轮上下文。交给模型的行情会按上海时区分层（近 1 小时分钟、至昨天凌晨小时、至上月日、更早月），不含秒级逐笔。用户点击「停止观察」前不会因为一轮完成而结束。`MONITOR_POLL_INTERVAL_MS` 可覆盖轮询频率，`HAOHAN_ANALYSIS_TIMEFRAMES` 与 `HAOHAN_KLINE_COUNT` 控制浩瀚数贸只读采集范围。即使模型给出 `BUY` / `SELL`，执行层仍全局禁止交易写请求和买卖控件点击。

后台默认入口：`http://127.0.0.1:5173/admin.html`。使用 `.env` 中的 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录；未加载 `.env` 时开发回退值为 `admin` / `local-admin`，不要用于共享环境。

## 数据库

用户已启动的本地容器可按环境变量接入。先创建数据库和表（不会自动覆盖已有表）：

```dotenv
DB_MODE=mysql
MYSQL_URL=mysql://root:<password>@127.0.0.1:3306/axiom_agent
```

```bash
mysql -h127.0.0.1 -P3306 -uroot -p < db/mysql/schema.sql
```

`MYSQL_URL` 中的数据库名必须与初始化脚本一致。使用 MongoDB 时：

```dotenv
DB_MODE=mongo
MONGO_URL=mongodb://127.0.0.1:27017
MONGO_DB=axiom_agent
```

再在目标数据库中执行 `db/mongo/indexes.js`。MySQL/Mongo 当前已支持任务、Skill、Provider、连接器、凭据元数据、订单和审计事件的首版恢复；未迁移的高级回测/成交明细仍使用后续模块。

## AI Provider

连接器页面支持任意 OpenAI Compatible Endpoint（例如自建服务、DeepSeek、OpenAI-compatible 网关）。API Key 只提交给本地 Node 服务，服务端使用 `APP_SECRET` 加密保存，前端只收到脱敏预览。Provider 的“验证”会在服务端请求 `<endpoint>/models`，只返回状态，不返回响应正文。没有 Key 时模型阶段会返回 HOLD，并带上 `PROVIDER_NOT_CONFIGURED`；真实分析需要配置 Provider 并由服务端发起。

## RAG 与初始化 Skill

用户端可上传 Markdown/TXT/JSON，或直接粘贴专家经验、规则和红线。内容先保存为 `REVIEW` 草稿，审核发布后切片进入 RAG 索引。检索结果保留 Skill 版本、chunk ID 和 evidence ID；草稿不会进入自动决策上下文。

项目内置 Skill：

- `skills/browser-operator`：白名单网站导航、数据提取和凭据引用。
- `skills/desktop-operator`：macOS/Windows 白名单 App 控制与人工接管。
- `skills/shell-executor`：参数数组、命令白名单、超时和审批。
- `skills/rag-knowledge`：专家经验切片、审核、版本与检索。
- `skills/trade-decision-router`：`AUTO`、`REVIEW`、`BLOCK` 规则路由。

## MCP

本地 MCP stdio 服务位于 `mcp/server.mjs`，配置示例位于 `mcp/axiom-tools.json`：

```bash
npm run mcp
```

暴露工具：浏览器导航/提取/连接器登录请求、白名单桌面 App 发现/启动、白名单 Shell 命令（包括 `bash` / `sh`）。Shell 和桌面动作没有明确 `approved: true` 时只返回审批要求；命令使用参数数组执行，不拼接自由格式 Shell 字符串。交易下单、提现、修改风控和扩大资金权限不在 MCP 工具列表中。

管理接口（账号、任务分配、审计摘要）要求登录后由 `x-admin-token` 会话访问；管理令牌不能访问 `/api/workspace`、任务控制、连接器、凭据、Provider 或 Skills 接口。上述客户端能力只接受桌面用户的 `x-user-token`，Provider、凭据和用户上传的 Skills 按桌面账号隔离；API CORS 默认只允许本地页面和 Electron 的 `null` 来源，可用 `CORS_ALLOWED_ORIGINS` 增加明确来源。Provider、连接器和 Skills 的操作不在后台页面提供。

## 当前适配边界

网站或 App 的登录字段、历史数据位置和买卖按钮因目标而异。创建任务时输入 URL/安装路径会自动生成目标档案并发现 Connector Adapter；已审核目标可继续进入凭据托管、监控、趋势分析、规则裁决和模拟动作链。通用网站/App 会保持 `REVIEW_REQUIRED`，不会猜测字段或自动点击交易控件。接入真实目标时，需要为目标增加一个 Connector Adapter（字段定位、数据映射、动作映射），通过模拟盘验证后再申请实盘权限。

当前唯一内置已审核示例包括 `https://demo.exchange.local` 的 `northstar-web`，以及 `https://smyw.haohandahan.cn` 的 `haohan-readonly`。后者只允许浏览、读取可见行情/历史/账户；买卖写接口被硬阻断。停止由服务端写入停止锁，禁止新决策/订单并切换人工接管，不会未经确认自动平仓。

## 打包

```bash
npm run dist:mac
npm run dist:win
```

macOS 构建在 `release/` 生成 `dmg` / `zip`（本机已验证 arm64 目录包）。Windows NSIS / portable 构建建议在 Windows 主机或 CI 执行；当前环境不能替代 Windows 安装运行验证。用户端进入 Electron 包，后台管理端仍通过浏览器访问，不打进用户工作流页面。

## Release 与自动更新

仓库使用 GitHub Release 分发桌面端。推送 `v*` 标签后，`.github/workflows/release.yml` 会分别构建 macOS universal 和 Windows x64，并发布安装包、portable 包及 `latest-mac.yml` / `latest.yml` 更新元数据：

```bash
git tag v0.2.1
git push origin main --tags
```

已安装的桌面端只在生产包中启用 `electron-updater`：启动后自动检查并下载更新，下载完成后可在顶部按钮重启安装；退出应用也会安装已下载版本。开发模式不会请求 GitHub。Windows 自动更新使用 NSIS 安装包，portable 版本适合手动下载更新。

正式发布应配置代码签名和 macOS 公证。GitHub Actions 使用 `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD`、`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 以及 Windows 的 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` secrets；未配置时仍会生成未签名测试包。未签名 macOS 包只适合本地测试，可能被 Gatekeeper 拦截，不能视作正式自动更新验证。自动更新默认面向公开 GitHub Release；私有仓库需要额外配置更新服务认证。

本地发布命令需要 `GH_TOKEN` 和已存在的 GitHub 仓库：

```bash
npm run release:mac
npm run release:win
```

## 检查

```bash
npm run typecheck
npm test
npm run build
```
