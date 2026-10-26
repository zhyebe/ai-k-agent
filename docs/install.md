# Axiom Agent v1.0 安装与使用

## 安装

macOS 使用对应架构的 DMG，将 Axiom Agent 拖入 Applications；Windows 使用 setup.exe，或解压后运行 portable.exe。安装包自带运行环境，不需要单独安装 Node.js、数据库、浏览器或部署服务器。

打开应用直接进入本机工作区。无需 Axiom 账号、密码、授权码或服务地址。点击「配置 AI」，填写接口地址、模型、协议与 API Key，在连接器中验证即可使用。目标网站本身的登录要求不变。

## 数据目录

正式安装版默认位置：

- macOS：`~/Library/Application Support/Axiom Agent/standalone/`
- Windows：`%APPDATA%\Axiom Agent\standalone\`

源码开发版通常使用 `axiom-agent` 作为应用目录名。目录实际由 Electron `app.getPath("userData")` 决定。

`workspace.json` 保存任务、经验和加密的 AI 配置；`.axiom-secret` 是解密所需密钥；`credentials.vault.json` 保存加密的目标凭据。退出应用后备份整个应用数据目录，可同时保存模型选择和 `browser-profiles` 中的目标网站登录状态。

缺失密钥、损坏数据或磁盘不可写时，应用会明确提示错误。请恢复原始备份或解决目录权限问题，不要删除密钥后继续使用旧数据。

## 从 v0.3 升级

v1.0 不连接旧服务器，也不会自动同步旧账号下的任务、Provider 或经验。旧数据不会被删除或覆盖。首次进入 v1.0 后重新配置 AI；需要保留的经验可导出文本后通过「导入经验」添加。

内置交易 Skill 在新工作区初始化一次。更新应用不会覆盖用户经验，删除的 Skill 不会重新出现。

## 运行

应用退出后本机引擎和内嵌浏览器关闭。重新打开时任务保持暂停；确认模型、目标页面和持仓后再启动。关闭应用不会自动处理已有实盘持仓。

本地配置与工作台无需网络；在线模型、目标网站与更新下载需要各自的网络连接。检查更新失败不影响本机工作区。

## 源码启动与打包

```bash
npm install
npm run dev
```

无需 `.env`。桌面应用忽略历史 `AXIOM_API_URL`、`connection.json`、MySQL/MongoDB 和登录配置。本机引擎仅绑定 `127.0.0.1`，操作系统分配空闲端口，应用自动连接；没有需要用户配置或部署的 API 服务。

```bash
npm run check
npm test
npm run test:standalone
npm run dist:mac
npm run dist:win
```

`npm start` 构建并打开桌面应用。`npm run dev:web` 仅用于开发界面；`npm run dev:api` 和部署脚本属于历史服务器维护入口，单机版无需运行。
