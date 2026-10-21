# SSH Manager

本地 SSH 与 SSH 隧道的管理界面。**不维护任何独立配置**——直接读取、呈现、修改本机已有的 `~/.ssh/config`（含 `Include` 引入的文件），隧道启停基于真实 ssh 进程。

支持 macOS 与 Windows（Linux 尽力而为）。

## 功能

### 连接

- 解析 `~/.ssh/config` 及 `Include`（含 glob）列出所有 Host，支持搜索
- 一键唤起系统终端（macOS: iTerm2 / Terminal.app；Windows: Windows Terminal / cmd）
- 执行的是从配置还原的**完整原始命令**（`ssh -p ... -l ... host`），所见即所执行，不经过别名二次解析；纯登录会话**不带**转发参数
- 新增 / 编辑 / 删除连接配置，直接写回 ssh config
- 支持「通过已有隧道」创建连接：本地转发出口（`HostName 127.0.0.1` + 隧道端口）或 SOCKS 动态转发出口（生成 `ProxyCommand nc -X 5 …`，仅 macOS/Linux）

### 隧道

- 隧道 = config 中含 `LocalForward` / `RemoteForward` / `DynamicForward` 的 Host 块
- **转发按需启用**：勾选任意子集启动；规则多时可折叠、搜索、全选，勾选状态本地记忆
- 两种启动方式：
  - **启动**——后台 `ssh -N` + BatchMode（适合密钥/agent 免密的标准 sshd）
  - **终端启动**——系统终端里执行还原后的原始命令（适合密码 / MFA 动态口令、或不支持 `-N` 的堡垒机，如部分 JumpServer 版本）
- 状态判定（两级校验）：
  - 进程级：扫描本机 ssh 进程，按别名 + HostName 双匹配，能识别「本工具启动」与「外部启动」
  - 端口级：只探测**实际启用**的转发本地端口（从进程命令行解析 `-L/-R/-D` 参数）
  - 状态：`运行中` / `运行中（外部）` / `异常`（进程在但端口不通，展示 stderr）/ `已停止`
- 状态查询时机：打开/刷新页面、启停操作后立即复查、可选的 5 秒轮询（默认关闭）

### 配置写入安全性

- 工具创建的配置块带 `# >>> ssh-mgr: <别名>` 标记，删除仅限带标记的块
- 编辑手写配置时做**指令级修补**：只改表单对应的指令行，注释、空行、其他选项逐字节保留（含 `Include` 引入的文件）
- 所有写入字段做换行/空白校验，防配置注入

## 运行

```bash
npm install
npm run dev        # 后端 API (127.0.0.1:8787) + 前端 Vite (默认 3000)
```

浏览器打开 Vite 提示的地址即可。

## 测试

```bash
HOME=/tmp/ssh-mgr-test npm test
```

自包含夹具（测试会自行重建 `/tmp/ssh-mgr-test/.ssh`），覆盖解析器、命令还原、进程匹配、转发提取、API 路由与配置增删改。

## 架构

```
server/
  sshConfig.js   # ssh_config 解析与写入（Include、标记块、指令级修补）
  sshCommand.js  # 配置 → 原始 ssh 命令还原
  processes.js   # 跨平台进程扫描（ps / Get-CimInstance）与端口探测
  tunnels.js     # 隧道启停与状态判定（启用转发识别）
  terminal.js    # 系统终端唤起（iTerm2 / Terminal / wt / cmd）
  app.js         # Express API（仅监听 127.0.0.1）
src/
  pages/Home.tsx               # 页签框架
  sections/ConnectionsSection  # 连接列表
  sections/TunnelsSection      # 隧道卡片 + 转发勾选
  sections/AddTunnelDialog     # 隧道新增/编辑（实时配置预览）
  sections/AddConnectionDialog # 连接新增/编辑（支持通过隧道）
scripts/
  dev.mjs        # 同时拉起后端与 Vite，透传 CLI 参数
  unit-test.mjs  # 无 socket 的单元/路由测试
```

技术栈：React 19 + Vite + Tailwind + shadcn/ui（前端），Express（后端），零自有存储。

## Windows 说明

- 依赖 Windows 10+ 自带的 OpenSSH 客户端（`ssh.exe` 在 PATH 中）
- 进程扫描走 PowerShell `Get-CimInstance`（不依赖已废弃的 wmic）
- SOCKS 出口连接（`ProxyCommand nc …`）不适用（无 nc）
