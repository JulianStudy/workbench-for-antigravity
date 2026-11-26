# Workbench 桌面验收记录

## `v0.2.0` 候选版本验收（分支 `workbench/v0.2.0-marketplace`）

开发与桌面验收环境：Antigravity 桌面 App **2.35.2**、`agy` CLI **1.5.16**、App 自带 Node.js **v24.22.0**（开发构建与 `npm test` 使用 Node.js **v24.22.3**）。

### 全局模式宿主探测结论（Antigravity 2.35.2）

- 全局安装插件可正常加载各工作区会话侧栏（`aux_pane`），由单个 MCP 服务进程处理多会话请求；`${PLUGIN_DATA}` 正确展开且可写；会话侧栏声明支持 `updateModelContext`。
- 宿主未声明 MCP `roots` 能力（`roots/list` 返回 `-31001`），`cwd`、`hostContext` 与请求元数据均不携带当前项目路径或 ID。
- 因此 `v0.2.0` 采用**每侧栏独立显式绑定**：受信任工作区列表持久化在 `${PLUGIN_DATA}/trusted-workspaces.json`，每次状态与运行请求由对应侧栏显式携带自己的 `workspaceId`，未绑定时禁用执行；原有按工作区安装模式（`.agents/plugins/workbench-<12hex>/` + `--expected-root`）继续保持兼容。

### 桌面验收：详情卡与全局模式 `A → B → A` 隔离（基于提交 `334af13`）

通过 `agy plugin install dist/workbench` 安装至 `~/.gemini/config/plugins/workbench`，全程未重启 App、未刷新 MCP、未修改代码：

| 验收项 | 实测结果 |
| --- | --- |
| Customizations 详情卡 | `Customizations → Installed → Workbench` 正常渲染 1:1 `assets/logo.svg`、154 字符描述、3 条 `suggestedPrompts` 快捷提示、`README.md` 与 `MCP` 标签页。 |
| 初始未绑定与每侧栏独立绑定 | `workbench-demo`（A）与 `gate2-peer`（B）首次打开全局侧栏均显示「未绑定」且禁用运行。A 信任并绑定后，B 下拉框可见已登记的 A，但 B 仍处于未绑定状态直至独立绑定 B。 |
| 双工作区运行与界面隔离 | 绑定后 A、B 各自「全部运行」均 `2/2` 通过（退出码均为 `0`）。B 跑完后切回一直打开的 A 侧栏，A 依然绑定 `workbench-demo`，未被 B 覆盖。 |
| 磁盘结果文件哈希隔离 | A 于北京时间 `2026-11-26 12:28:52` 写入 `.workbench/results.json`（SHA-256 `82e34a6b2207a85d84798b72a9238f904cf18304217cfe998459f93fd797a5d6`）。随后 B 运行仅于 `12:29:41` 更新 B 的 `.workbench/results.json`（SHA-256 `1cb08fc88bbf9c0a71869ecc91f08c8a0bdb71c6877008bad1f83ba8b5f1883e`），A 的文件哈希与修改时间均保持不变。全局 `${PLUGIN_DATA}/trusted-workspaces.json` 记录了 `workbench-demo`（`701df7f47d07`）与 `gate2-peer`（`545f1db34d4e`）。 |

### 安全边界验收：非 UI 宿主（CLI）与桌面 Agent

1. **真实 `agy` CLI 服务端拒绝**：在临时项目 `/tmp/wb-cli-sec-test` 下使用临时会话权限 `--settings '{"permissions":{"allow":["mcp(*)"]}}'` 让真实 `agy` CLI（`1.5.16`）直接触达已重装的全局 `0.2.0` 服务：
   - 只读 `workbench_ping` 正常返回（`mode: global`）；
   - `workbench_add_trusted_workspace`、`workbench_run_check`、`workbench_run_all` 均被服务端 `io.modelcontextprotocol/ui`（`text/html;profile=mcp-app`）能力门控直接拒绝（返回 `isError: true` 与拒绝说明）；
   - 磁盘核对确认空列表场景下未创建 `trusted-workspaces.json`，预置信任文件场景下未生成 `executed.marker` 也未创建 `.workbench/results.json`。
2. **移除信任（`workbench_remove_trusted_workspace`）的双重验证**：
   - 在真实 `agy` CLI 中调用 `workbench_remove_trusted_workspace` 被 CLI 拒绝（`tool workbench_remove_trusted_workspace is not enabled for server workbench_workbench_runner`），预置的 `trusted-workspaces.json` SHA-256（`c9bd5a08...500d5`）前后完全一致；
   - 在 `plugins/workbench-src/test/server-smoke.test.mjs` 中通过非 UI MCP 客户端直连打包产物 `dist/server.cjs`（全局模式与工作区模式），进一步实测确认服务端门控直接拒绝 `workbench_remove_trusted_workspace`（`isError: true`、`blockedByUiHostGate: true`）且 `trusted-workspaces.json` 哈希零变化。
3. **桌面 Agent 工具可见性与资源读取边界**：
   - 在 Antigravity 桌面 App `2.35.2` 会话中，宿主严格执行 `visibility: ["app"]`，仅向桌面 Agent 暴露只读入口工具 `open_workbench`；`workbench_add_trusted_workspace`、`workbench_remove_trusted_workspace`、`workbench_run_check`、`workbench_run_all`、`workbench_get_status` 对桌面 Agent 均不可见。
   - 单独实测确认桌面 Agent 可通过 `read_resource` 读取 `ui://workbench/pane.html`，因此本版本**未采用 HTML 内嵌 Token 的伪边界**，而是以 MCP `initialize` 阶段的 `clientCapabilities` 服务端门控 + 桌面宿主 `visibility: ["app"]` 共同构成信任边界。

### 自动化测试、严格校验与发布 ZIP 全局安装验证

- 在 `v0.2.0` 最终审查后补充了两项收敛修复与回归测试：
  1. `addTrustedWorkspace` 强制要求绝对路径（拒绝 `.`、`..`、相对路径与 `~`），避免按 MCP 进程 `cwd` 误解析或写入信任文件；
  2. `workbench_remove_trusted_workspace` 写入失败时服务端回读当前信任列表（而非返回 `[]`），且前端 `resolveNextTrustedWorkspaces` 在失败响应下保留现有下拉列表。
- `cd plugins/workbench-src && npm run build && npm test`（Node v24.22.3）：**65/65 通过，0 失败**。
- `agy-node --test test/*.test.mjs`（App 自带 Node v24.22.0）：**65/65 通过，0 失败**。
- `agy plugin validate --strict`：`dist/workbench`、发布 ZIP 解压后的 `dist/workbench`、全局安装目录 `~/.gemini/config/plugins/workbench` 及示例工作区安装目录 `work/workbench-demo/.agents/plugins/workbench-701df7f47d07` 均退出码 `0`（**0 error、0 warning、0 提示**）。
- **实际发布 ZIP 全局安装实测**：将 `workbench-for-antigravity-v0.2.0.zip`（SHA-256 `ba952de4bf83acc833fed6310d45705cc1f24a63b2c4fa4c84ecff2cbfb359d1`）解压到干净目录，无需 `npm install`，直接运行 `agy plugin install <解压目录>/dist/workbench` 覆盖安装至 `~/.gemini/config/plugins/workbench`：
  - 解压目录与已安装目录逐文件 SHA-256 完全一致；
  - `${PLUGIN_DATA}/trusted-workspaces.json` 哈希（`6fce3207...71f19b`）安装前后零变化；
  - 以 `agy-node` 直连已安装的 `~/.gemini/config/plugins/workbench/dist/server.cjs`（使用临时 `--plugin-data`）验证：`workbench_ping` 返回 `mode: global`，相对路径 `.` 被拒绝，非 UI 客户端被服务端门控拒绝。

---

## `v0.1.0-alpha.3` 候选版本验收（分支 `workbench/alpha.3`）

开发与桌面验收环境：Antigravity 桌面 App **2.34.0**、`agy` CLI **1.5.16**、App 自带 Node.js **v24.22.0**（开发构建与 `npm test` 使用 Node.js **v24.22.3**）。

### 阶段 1 关卡：双工作区执行隔离

- **旧版对照**：在 `alpha.2` 同名 `workbench` 安装下，切换两个工作区可能复用同一常驻 `workbench_workbench_runner` 进程。
- **独立身份实测（`A → B → A`，不重启 App、不刷新 MCP）**：
  - `workspace-a`（`workbench-demo-a`，PID `60730`）与 `workspace-b`（`workbench-demo-b`，PID `60803`）同时常驻。
  - `A (01:57:31)` 仅创建 A 的记录（`[marker] workspace-A`）；`B (02:03:01)` 仅创建 B 的记录（`[marker] workspace-B`，A 未变）；`回 A (02:03:20)` 仅更新 A 的记录（B 未变）。
- **菜单消歧与安装脚本**：实测发现多个 `Workbench` 菜单项易选错，已在 `install-workspace.mjs` 引入稳定哈希名 `workbench-<12位hex>`、`--expected-root` 严格绑定及 `Workbench (<目录名> · <4位hash>)` 入口标题。

### 阶段 2 关卡：可配置多条验收清单与跨工作区隔离

在 `work/workbench-demo`（`Workbench (workbench-demo · 701d)`，PID `14496`）与 `work/workbench-demo-copy/gate2-peer`（`Workbench (gate2-peer · 545f)`，PID `39354`）实测，全程未重启 App 或刷新 MCP：

| 验收项 | 实测结果 |
| --- | --- |
| 初始态与全部运行 | `workbench-demo` 两项（`format-total`、`clean-label`）初始均「未运行」；「全部运行」后均「通过」（`137 ms`、`72 ms`，退出码均 `0`）。 |
| 展开输出与轮询稳定 | 两项输出按需展开，跨多次 2 秒轮询（14 秒滚动观察 + 选中「去除标签首尾空格」跨 4 秒轮询）滚动位置与文字选中均保留。 |
| 仅改文件触发单项过期 | 仅给 `src/format-total.mjs` 加注释后，仅 `format-total` 标「已过期」并列出该文件，`clean-label` 保持「通过」。 |
| 单项重跑与证据隔离 | 单独重跑 `format-total` 后仅其时间戳更新为 `12:05:26`；`.workbench/results.json` 中 `clean-label` 整条记录 SHA-256（`3e389e30...5b801`）零字节变化。 |
| 仅改配置触发单项过期 | 将 `format-total.timeoutMs` 临时改为 `20000` 后，仅 `format-total` 标「已过期」（配置已变更），`clean-label` 保持「通过」。（注：修改在切回面板前完成，确认了状态与隔离，未独立秒表计时 5 秒弹出。） |
| 跨会话读回 | `workbench-demo` 新建会话重开侧栏，准确读回 `format-total`（`12:05:26`）与 `clean-label`（`11:52:31`）。 |
| 双工作区隔离 | 切到 `gate2-peer` 打开 `Workbench (gate2-peer · 545f)`，初始「未运行」，「全部运行」后两项通过（`113 ms`、`85 ms`，退出码均 `0`），仅写入 `gate2-peer/.workbench/results.json`（`52c4077f...`）；原 `workbench-demo/.workbench/results.json` 哈希（`2e3ac003...65977`）与修改时间均未变。 |

以上阶段 2 桌面验收在 `work/workbench-demo` 与 `gate2-peer` 完成。

### 阶段 3 关卡：失败证据预览与 `app.updateModelContext()` 附加

全程未重启 App、未刷新 MCP，仅重开侧栏加载新版 `dist/pane.html`：

| 验收项 | 实测结果 |
| --- | --- |
| 两条失败先后附加与替换 | 在 `workbench-demo` 制造两条不同失败（`format-total` 实际值 `¥1250.00`、`clean-label` 实际值 `BROKEN_DEMO_LABEL:  demo  `）。先预览并确认附加 `format-total`，再预览并确认附加 `clean-label`；两次点击后对话均未自动发送消息。用户手动发送复述请求后，Agent 仅复述第二条 `clean-label`（退出码 `1`，含 `BROKEN_DEMO_LABEL`）。 |
| 跨工作区附加隔离 | 切到 `gate2-peer`（`format-total` 失败实际值 `¥9999.00-PEER`，`clean-label` 通过），确认附加后对话未自动发送；手动发送同样复述请求后，Agent 仅复述本工作区的 `format-total`（退出码 `1`，`¥9999.00-PEER`）。 |

### 自动化测试与严格校验

- `cd plugins/workbench-src && npm ci && npm run build && npm test`（Node v24.22.3）：**37/37 通过，0 失败**。
- `agy-node --test test/*.test.mjs`（App 自带 Node v24.22.0）：**37/37 通过，0 失败**。
- `agy plugin validate <安装目录> --strict`：`work/workbench-demo`（`workbench-701df7f47d07`）与 `work/workbench-demo-copy/gate2-peer`（`workbench-545f1db34d4e`）均退出码 `0`。

### 发布前真实项目试用与重装回归

- 在 Antigravity Network Doctor 的独立副本（提交 `8cd551e`）新增一条验收项。桌面侧栏从 MCP 服务的 `PATH` 找到 `python3`，运行项目的 `python3 -B -m unittest discover -s tests`，**33/33 通过**，退出码 `0`。侧栏检查目录指向独立副本，`.workbench/results.json` 中保存了同一次结果。该副本通过 `agy plugin validate --strict`。
- 重装先在临时目录准备新包，检查关键清单字段、服务脚本和侧栏内联脚本，再替换原安装。回归覆盖损坏的新包、替换失败回滚，以及并发替换冲突时保留可用安装与旧备份。修复后 Node v24.22.3 和 App 自带 Node v24.22.0 均 **41/41 通过**。

---

## 历史记录：`v0.1.0-alpha.2` 原型验收

使用 Antigravity 桌面 App 2.34.0、`agy` CLI 1.5.16 与 App 内置 Node.js v24.22.0 完成单条固定检查的通过、失败、改注释 5 秒内自动过期、跨会话持久化读回及干净副本安装校验。
