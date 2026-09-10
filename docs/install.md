# 部署与安装

Axiom 用户端是 Electron 桌面应用，后台管理是浏览器访问的 B/S 页面。当前版本只做到浏览目标、采集数据、分析趋势并给出买卖建议；服务端全局禁止创建订单、撤单、提现和点击目标网站的买入/卖出按钮。

生产拓扑：Node.js API、MySQL/MongoDB 和后台静态页面部署在服务器；桌面端只连接 API，不承担账号、任务分配或数据库存储。一个 API 实例必须使用共享持久化数据库，不能让后台和桌面各自启动内存服务。

## 1. 准备

- Node.js 20+
- 可选：Docker MySQL / MongoDB
- 目标网站 Chrome 可访问；本机已安装 Chrome 时，分析会优先读取可见页面

复制环境变量：

```bash
cp .env.example .env
```

至少修改：

- `APP_SECRET`
- `ADMIN_PASSWORD`
- `DESKTOP_USERNAME` / `DESKTOP_PASSWORD`（首次启动会创建桌面用户，并分配已有任务）
- `DEEPSEEK_API_KEY`（或在桌面端连接器页面保存任意 OpenAI Compatible Provider）

浏览器白名单需包含目标域名，例如：

```dotenv
BROWSER_ALLOWED_DOMAINS=localhost,127.0.0.1,smyw.haohandahan.cn
```

## 2. 数据库

本地快速演示可用内存仓储：`DB_MODE=memory`。需要验证后台分配和桌面登录时，必须使用同一个 MySQL/Mongo API 实例；不要同时启动多个内存 API。

MySQL：

```bash
mysql -h127.0.0.1 -P3306 -uroot -p < db/mysql/schema.sql
```

```dotenv
HOST=127.0.0.1
DB_MODE=mysql
MYSQL_URL=mysql://root:<password>@127.0.0.1:3306/axiom_agent
ALLOW_MEMORY_FALLBACK=0
```

MongoDB 执行 `db/mongo/indexes.js`，并设置 `DB_MODE=mongo`。

登录态保存在 `user_sessions`。会话过期后，桌面端需要重新登录；分析过程若发现目标网站回到登录页，会使用托管凭据自动填充并提交登录，但不会提交买卖表单。

## 3.1 持续监控生命周期

「开始观察」只创建后台监控控制器，不代表只执行一次。服务端在任务进程中持续运行，直到用户点击「停止观察」或任务被明确切换为人工接管：

1. 启动后立即执行首轮连接、登录、只读采集和分析。
2. 首轮完成后按轮询间隔再次读取目标页面和只读行情；浏览器会话复用，不因每轮检查主动刷新登录态。
3. 每次采集包含主周期历史 K 线、配置的全部分钟/小时/日/周/月周期、实时逐笔数据、页面可见字段和账户只读字段。周期由 `HAOHAN_ANALYSIS_TIMEFRAMES` 控制，历史根数由 `HAOHAN_KLINE_COUNT` 控制。
4. 服务端对规范化行情计算指纹。行情未变化时只记录一次检查并跳过模型请求；首次检查、上次模型失败或指纹变化时，才把当前完整快照交给 AI，并附带最近监控轮次作为多轮上下文。
5. 网络、登录或模型异常不会结束任务。控制器使用退避后继续重试；`monitoringEnabled=true` 时，即使界面状态显示「已暂停」，后台仍会继续只读监测，直到用户停止。
6. 点击「停止观察」会写入停止锁、清除下一次定时器。正在执行的轮次结束后也不能创建新轮次、订单或交易写请求。

默认轮询间隔按任务周期设置：1 分钟周期约 5 秒，3/5 分钟约 7 秒，10/15 分钟约 10 秒，30 分钟至 2 小时约 15 秒，其他周期约 30 秒。设置 `MONITOR_POLL_INTERVAL_MS` 可统一覆盖，范围为 1-120 秒。轮询是实时变化探测频率，不等于等待一根 K 线收盘；只有行情指纹变化才触发 AI 分析。

## 4. 本地运行

```bash
npm install
npm run dev
```

- 用户端：`http://127.0.0.1:5173/`
- 后台：`http://127.0.0.1:5173/admin.html`
- 桌面端：`npm run dev:desktop`

首次进入用户端使用 `DESKTOP_USERNAME` 登录。若未配置桌面用户，先到后台「账号与分配」创建账号并分配任务。后台只管理账号、密码、分配和日志；连接器、Provider、Skills 和分析配置在桌面端完成。服务端用 `x-admin-token` 和 `x-user-token` 分隔两类会话：管理令牌不能读取或操作客户端工作区，客户端配置按桌面账号保存。后台和用户端都必须指向同一个 API 地址；桌面登录页的「服务地址」可保存服务器 URL。

桌面端默认连接 `http://127.0.0.1:8787`，地址保存在本机应用配置中。打包客户端默认不会自启 API；仅设置 `AXIOM_EMBEDDED_API=1` 时才启用一次性本地内嵌服务，不能用于多人或生产部署。

## 5. 建议试运行

1. 在连接器中填写目标 URL 和登录账号密码，测试连接（密码写入本地 Vault）。
2. 打开任务控制台，点击「立即分析」。
3. 打开「查看 Agent 输出流」，确认阶段为 `connect → login → collect → analyze → rules → action`。
4. `BUY` / `SELL` 只会显示为建议，`action` 阶段应出现“未创建订单”。
5. 保持页面运行数个轮询周期，确认输出流出现多条「本轮只读行情与上轮一致，跳过模型请求」或新的分析轮次；修改行情后应看到新的模型轮次和上一轮上下文。
6. 点击「停止观察」，确认不再新增运行记录。

不要测试全自动下单。

## 6. 打包

```bash
npm run dist:mac
npm run dist:win
```

安装包输出到 `release/`。GitHub Release 与自动更新见仓库 README。未签名的 macOS 包只适合本机测试。
