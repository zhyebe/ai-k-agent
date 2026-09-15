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

当前版本实盘出现买卖建议时会弹窗，确认后才会在已登录页面下单。生产部署见 [docs/deploy.md](docs/deploy.md)，本地安装与试运行见 [docs/install.md](docs/install.md)。

生产环境里，账号、任务、Provider 配置和密钥保存在服务端；内嵌浏览器、登录、行情及盘口采集、指标整理与模型请求全部运行在客户端。已审核经验全文随本轮行情直接交给 AI，后端不做分片分析或 RAG 索引。桌面必须保持登录在线，旧版本会提示升级，禁止回退到服务端浏览器。GitHub Actions 构建发布镜像，服务器只加载镜像并运行账号与数据服务。

「开始观察」启动的是服务端持续控制循环：首轮立即执行，普通轮次完成后立即开始下一轮。监控轮次只把最近 1 小时的分钟数据交给 AI；手动分析仍可使用按上海时区分层的历史 K 线。出现买卖提示时暂停下一轮，等待用户确认或取消；全自动下单完成后立即继续。规范化行情未变化时跳过 AI，变化、首轮或上轮失败时开启新的分析轮次，并把最近轮次作为多轮上下文。用户点击「停止观察」前不会因为一轮完成而结束。`MONITOR_POLL_INTERVAL_MS` 可显式增加轮询间隔，`HAOHAN_ANALYSIS_TIMEFRAMES` 与 `HAOHAN_KLINE_COUNT` 控制浩瀚数贸只读采集范围。模型给出 `BUY` / `SELL` 后，实盘任务会弹窗；只有你确认，服务端才会在已登录页面提交订单。观察 / 影子模式不会实盘下单。`AXIOM_TRADING_ENABLED=0` 可整机关闭实盘提交。

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

连接器页面支持 OpenAI Compatible、Responses、Anthropic 和 Gemini 协议。API Key 提交给生产 API，使用 `APP_SECRET` 加密保存，页面只收到脱敏预览。Provider 验证使用配置模型发起真实推理；验证、模型列表和分析请求均由客户端发出。地址按配置协议和响应选择匹配路由，不强制添加 `/v1`。未配置 Key 会明确返回 `PROVIDER_NOT_CONFIGURED`。

## RAG 与初始化 Skill

用户端可上传 Markdown/TXT/JSON，或直接粘贴专家经验、规则和红线。内容先保存为 `REVIEW` 草稿。生产环境中，审核后的经验全文携带版本和 evidence ID，与行情一起直接交给客户端 AI；不建立切片索引。草稿和其他账号的经验不会进入分析上下文。经验超出上下文上限时明确报错。

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

macOS 构建生成 `dmg` / `zip`；Windows x64 构建生成 NSIS 安装包和 portable。Release 流水线在各系统运行打包后浏览器验证，检查中文及空格用户目录、页面读取、盘口解析和会话关闭。运行 `npm run test:desktop-browser` 可验证开发版本；设置 `AXIOM_DESKTOP_EXECUTABLE` 可验证对应系统的打包程序。用户端进入 Electron 包，后台管理端仍通过浏览器访问。

## Release 与自动更新

仓库使用 GitHub Release 分发桌面端。推送 `v*` 标签后，`.github/workflows/release.yml` 会分别构建 macOS universal 和 Windows x64，并发布安装包、portable 包及 `latest-mac.yml` / `latest.yml` 更新元数据：

```bash
git tag v0.2.8
git push origin main --tags
```

已安装的生产包启动后向 GitHub Release 检查更新，下载当前系统的 `dmg`（macOS）或 NSIS `setup.exe`（Windows）。点安装后用系统打开安装包并退出当前应用；Windows 会先结束本进程再启动安装器，避免文件占用。开发模式不会请求 GitHub。portable 不走自动更新。

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

加载状态浏览器回归（慢请求、失败重试、后台刷新和并发请求）：

```bash
npx playwright install chromium
npm run test:ui
```

已有 Chrome 时可直接运行 `PLAYWRIGHT_CHANNEL=chrome npm run test:ui`。
