# Workbench（本地验收检查插件 v0.2.0）

Workbench 是一个零外部运行时依赖的 Antigravity 插件（MCP Server + MCP App 侧栏），同时支持 **全局模式（Global Mode，支持 CLI 全局安装与 Marketplace 分发）** 与 **工作区绑定模式（Workspace Mode）**。它读取目标项目根目录的 `workbench.json`，支持多条验收检查的单项运行与串行全跑、按工作区独立绑定防串目录、以 `.workbench/results.json`（`schemaVersion: 2`）按检查 ID 原子持久化最近一次证据，并支持在检查失败时预览并显式将脱敏摘要附到下一条对话消息。

## 包含文件

```text
workbench/
├── plugin.json          # 插件清单（含 v0.2.0 元数据、logo、keywords 与 suggestedPrompts）
├── mcp_config.json      # 本地 stdio MCP 配置（command: "node" + ${PLUGIN_ROOT} + --plugin-data ${PLUGIN_DATA}）
├── assets/logo.svg      # 插件矢量图标（满足 strict 校验零警告要求）
├── dist/server.cjs      # 零 node_modules 依赖的双模式服务端产物
├── dist/pane.html       # 单文件内联 MCP App 侧栏（符合默认 CSP）
└── README.md            # 本说明
```

## 安装方式

### 方式一：全局安装（推荐 / Marketplace 就绪）

在仓库的 `plugins/workbench-src/` 目录构建产物后，通过 `agy` 全局安装（发布到 Marketplace 后亦可直接一键安装）：

```bash
cd plugins/workbench-src
npm ci
npm run build
agy plugin install ../../dist/workbench
```

全局模式工作原理（已在 Antigravity **2.35.2** 验证）：

- **受信任工作区持久化**：你在侧栏中添加的工作区会经过 `realpath` 归一化并持久化到 `${PLUGIN_DATA}/trusted-workspaces.json`。从列表中移除工作区仅取消信任记录，不会删除本地项目文件或 `.workbench/results.json`。
- **每个侧栏独立绑定、默认未绑定**：每次新打开侧栏默认处于 **「未绑定」** 状态并禁用运行，直到你显式选择或添加一个受信任工作区。每个侧栏在内存中独立维护自己的 `workspaceId` 并在每次请求中携带，因此在会话 B 切换工作区**绝不会影响**会话 A，且不同工作区拥有各自独立的执行锁。
- **零侵入项目目录**：每个项目只需提交 `workbench.json`，并在 `.gitignore` 忽略 `/.workbench/` 即可。

### 方式二：工作区隔离安装（按项目独立绑定）

若希望为单个受信任项目生成独立绑定的本地插件副本（**不要**直接把已安装目录复制到另一个项目）：

1. 在仓库的 `plugins/workbench-src/` 目录先构建并运行安装脚本：
   ```bash
   cd plugins/workbench-src
   npm ci
   npm run build
   node scripts/install-workspace.mjs /path/to/your/workspace
   ```
   脚本会对目标路径做 `realpath` 归一化，生成稳定目录 `<workspace>/.agents/plugins/workbench-<12位SHA-256前缀>/`，写入绑定参数 `--expected-root` 与带目录短哈希的菜单标题 `Workbench (<目录名> · <4位hash>)`，并打印最终安装目录。工作区模式下全局选择器会自动隐藏。
2. 在目标工作区根目录添加 `workbench.json`（示例见仓库根目录 `README.md` 与 `work/workbench-demo/workbench.json`）。
3. 在目标工作区的 `.gitignore` 中忽略本机安装目录与结果文件（`workbench.json` 可提交进 Git 团队共享）：
   ```gitignore
   /.workbench/
   /.agents/plugins/workbench-*/
   ```

### 严格校验

无论是全局构建产物 `dist/workbench` 还是工作区安装目录，均可运行严格校验（需当前 shell `PATH` 含 `node`；桌面 App 运行时无需全局 `node`，会自动回退到自带 Node）：

```bash
agy plugin validate ../../dist/workbench --strict
agy plugin validate <安装脚本输出的目录> --strict
```

预期退出码为 `0`（0 errors, 0 warnings, 0 notes）。

## 从 `alpha.2` 升级与冲突处理

- 工作区绑定模式下，同一工作区只保留一个 Workbench 安装。若 `.agents/plugins/` 下存在旧版 `workbench/` 或其他 `workbench-<12位hex>/`，安装脚本会**直接停止并列出冲突目录**，不会擅自删除任何文件。
- 请先手动将旧版目录移出 `.agents/plugins/` 再重新运行安装脚本；同一真实工作区的同一绑定支持幂等重复安装。
- 旧版 `.workbench/last-run.json` 会原样保留，新版读写 `.workbench/results.json`（`schemaVersion: 2`），新检查 ID 从「未运行」开始。

## 在 Antigravity 桌面 App 中使用

1. 在左侧 **Projects** 打开目标工作区，并在会话顶部 **`⋮` → Plugins** 或 **Overview → Plugins** 中打开 **Workbench**（工作区模式显示为 `Workbench (<目录名> · <4位hash>)`）。
2. **全局模式**：先在顶部 **「受信任工作区」** 卡片中点 **「+ 添加」** 粘贴项目绝对路径并点击 **「信任并绑定」**（或从下拉框选择已有受信任工作区）。未绑定前所有运行按钮均保持禁用。
3. 核对面板显示的检查目录无误后，可使用顶部 **「全部运行」** 或单张卡片的 **「运行」**，按需展开 **「查看输出」**。
4. 当某项当前状态为有效的 **「失败」** 时，可点击 **「附加失败证据」** 预览脱敏后的摘要（严格 ≤ 2 KiB UTF-8 字节，含截断提示），确认后再点 **「确认附加到下一条消息」**，最后由你手动发送下一条消息。该操作不会自动发起对话；再次附加会替换上一次挂起的失败证据。

## 移除插件

- **全局安装**：运行 `agy plugin uninstall workbench`（或通过插件管理界面卸载），再重启 Antigravity App。
- **工作区安装**：删除目标工作区中的 `.agents/plugins/workbench-<12位hex>/`（如需清除检查记录，再删除 `.workbench/`），重启 Antigravity App 以结束对应常驻服务进程。

## 已知边界与排错

- **仅信任可信工作区**：仅在信任其测试命令的工作区添加/安装；所有命令均以 `shell: false` 在绑定的工作区根目录执行。
- **禁止复制工作区安装目录到其他项目**：工作区绑定模式启动时强制核对 `--expected-root` 与实际解析出的工作区根目录，缺失或不一致时会禁用运行并提示重新用安装脚本安装。
- **跟踪路径限制**：`workbench.json` 的 `files` 只支持显式仓库相对路径；绝对路径、`..` 越界以及指向工作区外的符号链接（含悬空链接）均会报错。正常删除的工作区内文件记为 `MISSING` 并标「已过期」。
- **批跑配置变更保护**：点击「全部运行」期间，若排队中的某项配置在执行前发生变更，服务端会跳过该项并提示用户重新运行，不会执行未确认的新命令。
- **仅支持桌面侧栏入口（服务端 UI 宿主能力校验）**：所有变更与执行类工具（`workbench_add_trusted_workspace`、`workbench_remove_trusted_workspace`、`workbench_run_check`、`workbench_run_all`）均在服务端强制校验客户端的 MCP App UI 能力声明（`io.modelcontextprotocol/ui` 且支持 `text/html;profile=mcp-app`）；未声明该能力的非 UI 宿主（如 `agy` CLI）会在服务端直接拒绝，不会修改受信任工作区或触发命令执行。
- **关窗与持久化边界**：每项仅持久化最近一次已完成的结果；Antigravity 关闭侧栏会中止前端在途 `tools/call`，不承诺运行中途关窗必产新结果。
