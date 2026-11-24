# Workbench（本地验收检查工作区插件）

Workbench 是一个零外部运行时依赖的 Antigravity 工作区插件（MCP Server + MCP App 侧栏）。它从插件安装位置自动定位当前项目根目录，在侧栏内执行固定验收命令，对比受跟踪源码的内容指纹，并将最近一次已完成的检查证据原子持久化到 `<projectRoot>/.workbench/last-run.json`。

## 包含文件

```text
workbench/
├── plugin.json          # 插件清单
├── mcp_config.json      # 本地 stdio MCP 配置（command: "node" + ${PLUGIN_ROOT}）
├── dist/server.cjs      # 零 node_modules 依赖的服务端产物
├── dist/pane.html       # 单文件内联 MCP App 侧栏（符合默认 CSP）
└── README.md            # 本说明
```

## 安装到目标项目

此原型运行示例项目固定的 `test/format-total.test.mjs`，并跟踪该测试和 `src/format-total.mjs`。在另一个工作区试用时，同时复制这两个示例文件，并核对侧栏里的检查目录。仅在信任测试代码的工作区运行。

1. 将整个 `workbench/` 目录复制到目标项目根目录的 `.agents/plugins/workbench/`：
   ```bash
   project_dir="/path/to/your/project"
   mkdir -p "$project_dir/.agents/plugins"
   cp -R dist/workbench "$project_dir/.agents/plugins/workbench"
   ```
2. 在目标项目的 `.gitignore` 中添加：
   ```gitignore
   .workbench/
   ```
3. 运行严格校验（需确保当前 shell 的 `PATH` 包含 `node`，否则 `--strict` 会提示 `command "node" isn't on this machine's PATH` 警告；桌面 App 运行时无需全局 `node`，会自动回退到自带 Node）：
   ```bash
   cd "$project_dir"
   agy plugin validate .agents/plugins/workbench --strict
   ```
   预期退出码为 `0`（`✔ Validation passed`）。

## 在 Antigravity 桌面 App 中使用

1. 在 Antigravity 桌面 App 左侧 **Projects** 打开目标项目根目录，并在该项目下新建或进入一个会话（至少发送一条消息触发该工作区插件加载）。
2. 通过会话的 **Overview → Plugins → Workbench** 或会话顶部 **`⋮` → Plugins → Workbench** 打开侧栏。
3. 核对面板显示的 **当前检查目录** 为目标项目根目录，点击 **「运行检查」** 触发检查；打开期间侧栏每 2 秒自动检测文件变化，也支持点击 **「手动刷新」**。

## 切换同名副本项目或更新插件后重启服务

Antigravity 桌面 App（实测 `2.34.0`）对同名工作区插件的 MCP 服务（`workbench_workbench_runner`）采用全局单进程复用，且工作区级插件不出现在全局 `Customizations > Installed` 页面。

当你在同一 App 内**从原项目切换到安装了同名 Workbench 插件的副本项目**，或**覆盖更新了 `dist/server.cjs`** 时：
1. 重启 Antigravity App，以结束上一个工作区的常驻服务进程。
2. 回到目标项目的会话发送一条消息触发重新加载，再重新打开 **`⋮` → Plugins → Workbench**，核对「当前检查目录」已切换至目标目录。

## 移除插件

1. 从目标项目移除 `.agents/plugins/workbench/`。如需清除上次检查证据，可另外移除 `.workbench/`。
2. 重启 Antigravity App 以结束常驻服务进程。

## 已知边界与排错

- **仅支持工作区级安装**：请勿复制到全局 `~/.gemini/config/plugins/`；服务端严格校验路径必须匹配 `<projectRoot>/.agents/plugins/<dir>`，误装到全局目录会拒绝执行并在面板显示明确错误提示。
- **持久化与关窗边界**：首版仅持久化最近一次已完成的检查至 `.workbench/last-run.json`（重跑覆盖旧记录）；Antigravity 关闭侧栏会中止前端在途 `tools/call`，不承诺运行中途关窗必产新结果，重开侧栏按磁盘已有记录如实展示。
- **过期判定边界**：通过“运行前 + 运行后”以及“读取状态时”的 SHA-256 内容指纹对比判定过期（文件缺失计入变化）；不检测运行过程中改完又在结束前改回原样的瞬态变化。
- **找不到插件**：确认桌面 App 当前激活的会话属于安装了 `.agents/plugins/workbench/` 的目标项目，而非其父目录或其他项目，并检查全局 `~/.gemini/config/plugins/` 下无同名 `workbench` 冲突。
