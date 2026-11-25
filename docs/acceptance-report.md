# Workbench 桌面验收记录

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

> **说明**：以上阶段 2 桌面验收在 `work/workbench-demo` 与 `gate2-peer` 完成，尚未在二者之外的第三个真实外部项目里试用。

### 阶段 3 关卡：失败证据预览与 `app.updateModelContext()` 附加

全程未重启 App、未刷新 MCP，仅重开侧栏加载新版 `dist/pane.html`：

| 验收项 | 实测结果 |
| --- | --- |
| 两条失败先后附加与替换 | 在 `workbench-demo` 制造两条不同失败（`format-total` 实际值 `¥1250.00`、`clean-label` 实际值 `BROKEN_DEMO_LABEL:  demo  `）。先预览并确认附加 `format-total`，再预览并确认附加 `clean-label`；两次点击后对话均未自动发送消息。用户手动发送复述请求后，Agent 仅复述第二条 `clean-label`（退出码 `1`，含 `BROKEN_DEMO_LABEL`）。 |
| 跨工作区附加隔离 | 切到 `gate2-peer`（`format-total` 失败实际值 `¥9999.00-PEER`，`clean-label` 通过），确认附加后对话未自动发送；手动发送同样复述请求后，Agent 仅复述本工作区的 `format-total`（退出码 `1`，`¥9999.00-PEER`）。 |

### 自动化测试与严格校验

- `cd plugins/workbench-src && npm ci && npm run build && npm test`（Node v24.22.3）：**36/36 通过，0 失败**。
- `agy-node --test test/*.test.mjs`（App 自带 Node v24.22.0）：**36/36 通过，0 失败**。
- `agy plugin validate <安装目录> --strict`：`work/workbench-demo`（`workbench-701df7f47d07`）与 `work/workbench-demo-copy/gate2-peer`（`workbench-545f1db34d4e`）均退出码 `0`。

---

## 历史记录：`v0.1.0-alpha.2` 原型验收

使用 Antigravity 桌面 App 2.34.0、`agy` CLI 1.5.16 与 App 内置 Node.js v24.22.0 完成单条固定检查的通过、失败、改注释 5 秒内自动过期、跨会话持久化读回及干净副本安装校验。
