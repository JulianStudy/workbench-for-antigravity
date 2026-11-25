# Workbench（本地验收检查工作区插件）

Workbench 是一个零外部运行时依赖的 Antigravity 工作区插件（MCP Server + MCP App 侧栏）。它读取工作区根目录的 `workbench.json`，支持多条验收检查的单项运行与串行全跑、按工作区独立绑定防串目录、以 `.workbench/results.json`（`schemaVersion: 2`）按检查 ID 原子持久化最近一次证据，并支持在检查失败时预览并显式将脱敏摘要附到下一条对话消息。

## 包含文件

```text
workbench/
├── plugin.json          # 插件清单（安装时写入独立 name 与 displayName）
├── mcp_config.json      # 本地 stdio MCP 配置（command: "node" + ${PLUGIN_ROOT} + --expected-root）
├── dist/server.cjs      # 零 node_modules 依赖的服务端产物
├── dist/pane.html       # 单文件内联 MCP App 侧栏（符合默认 CSP）
└── README.md            # 本说明
```

## 为工作区安装（推荐且唯一支持方式）

仅在信任其测试代码的工作区安装。每个工作区必须使用安装脚本生成自己的独立绑定（**不要**直接把已安装目录复制到另一个项目）：

1. 在仓库的 `plugins/workbench-src/` 目录先构建并运行安装脚本：
   ```bash
   cd plugins/workbench-src
   npm ci
   npm run build
   node scripts/install-workspace.mjs /path/to/your/workspace
   ```
   脚本会对目标路径做 `realpath` 归一化，生成稳定目录 `<workspace>/.agents/plugins/workbench-<12位SHA-256前缀>/`，写入绑定参数 `--expected-root` 与带目录短哈希的菜单标题 `Workbench (<目录名> · <4位hash>)`，并打印最终安装目录。
2. 在目标工作区根目录添加 `workbench.json`（示例见仓库根目录 `README.md` 与 `work/workbench-demo/workbench.json`）。
3. 在目标工作区的 `.gitignore` 中忽略本机安装目录与结果文件（`workbench.json` 可提交进 Git 团队共享）：
   ```gitignore
   /.workbench/
   /.agents/plugins/workbench-*/
   ```
4. 对脚本输出的安装目录运行严格校验（需当前 shell `PATH` 含 `node`；桌面 App 运行时无需全局 `node`，会自动回退到自带 Node）：
   ```bash
   agy plugin validate <安装脚本输出的目录> --strict
   ```
   预期退出码为 `0`（`✔ Validation passed`）。

## 从 `alpha.2` 升级与冲突处理

- 同一工作区只保留一个 Workbench 安装。若 `.agents/plugins/` 下存在旧版 `workbench/` 或其他 `workbench-<12位hex>/`，安装脚本会**直接停止并列出冲突目录**，不会擅自删除任何文件。
- 请先手动将旧版目录移出 `.agents/plugins/` 再重新运行安装脚本；同一真实工作区的同一绑定支持幂等重复安装。
- 旧版 `.workbench/last-run.json` 会原样保留，`alpha.3` 读写 `.workbench/results.json`（`schemaVersion: 2`），新检查 ID 从「未运行」开始。

## 在 Antigravity 桌面 App 中使用

1. 在左侧 **Projects** 打开目标工作区根目录，并在该工作区会话中发一条消息触发加载。
2. 通过 **Overview → Plugins** 或会话顶部 **`⋮` → Plugins** 选择对应工作区的 **`Workbench (<目录名> · <4位hash>)`**。
3. 核对面板显示的检查目录无误后，可使用顶部 **「全部运行」** 或单张卡片的 **「运行」**，按需展开 **「查看输出」**。
4. 当某项当前状态为有效的 **「失败」** 时，可点击 **「附加失败证据」** 预览脱敏后的摘要（严格 ≤ 2 KiB UTF-8 字节，含截断提示），确认后再点 **「确认附加到下一条消息」**，最后由你手动发送下一条消息。该操作不会自动发起对话；再次附加会替换上一次挂起的失败证据。

## 移除插件

1. 删除目标工作区中的 `.agents/plugins/workbench-<12位hex>/`（如需清除检查记录，再删除 `.workbench/`）。
2. 重启 Antigravity App 以结束对应常驻服务进程。

## 已知边界与排错

- **禁止复制已安装目录到其他项目**：服务端启动时强制核对 `--expected-root` 与实际解析出的工作区根目录，缺失或不一致时会禁用运行并提示重新用安装脚本安装。
- **跟踪路径限制**：`workbench.json` 的 `files` 只支持显式仓库相对路径；绝对路径、`..` 越界以及指向工作区外的符号链接（含悬空链接）均会报错。正常删除的工作区内文件记为 `MISSING` 并标「已过期」。
- **批跑配置变更保护**：点击「全部运行」期间，若排队中的某项配置在执行前发生变更，服务端会跳过该项并提示用户重新运行，不会执行未确认的新命令。
- **仅支持桌面侧栏入口**：Antigravity CLI 会忽略部分 UI 可见性元数据，暂不把 CLI 或 Agent 自动调用作为支持路径。
- **关窗与持久化边界**：每项仅持久化最近一次已完成的结果；Antigravity 关闭侧栏会中止前端在途 `tools/call`，不承诺运行中途关窗必产新结果。
