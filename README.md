# Workbench for Antigravity

Workbench adds a local acceptance-check sidebar to the Antigravity desktop app (`v0.2.0`), supporting both **Global Mode** (single user-level / Marketplace install with per-pane trusted workspace binding) and **Workspace-Scoped Mode** (per-project isolated install). Each project defines its checks in `workbench.json` at the workspace root, runs checks individually or sequentially, tracks per-check staleness against tracked files and check config, persists each check's latest completed evidence to `.workbench/results.json` (`schemaVersion: 2`), and lets the user preview and explicitly attach a valid redacted failure summary to the next conversation message via `app.updateModelContext()`.

## Build and test

Use Node.js 24 and npm. From the repository root, run:

```sh
cd plugins/workbench-src
npm ci
npm run build
npm test
```

`npm run build` outputs the self-contained Marketplace-ready plugin bundle at `dist/workbench/` (zero runtime `node_modules`, including `assets/logo.svg` and `plugin.json` metadata) and installs a workspace-bound copy into `work/workbench-demo/`.

Validate either the global bundle or a workspace-scoped install with zero errors, warnings, or notes:

```sh
agy plugin validate dist/workbench --strict
agy plugin validate <installed-plugin-dir> --strict
```

## Installation modes

### 1. Global Installation (recommended / Marketplace-ready)

Install the built plugin globally via Antigravity CLI (or from the Antigravity Plugin Marketplace once published):

```sh
agy plugin install ./dist/workbench
```

How Global Mode works (verified on Antigravity **2.35.2**):

- **Explicit trusted-workspace registry**: Trusted project directories are stored in `${PLUGIN_DATA}/trusted-workspaces.json` (`realpath`-normalized). Add or remove directories directly in the sidebar's **Trusted Workspaces** card; removing a workspace from the trusted list never deletes project files or `.workbench/results.json`.
- **Independent per-pane binding**: Every fresh sidebar opens **unbound** with execution disabled until you explicitly choose or add a trusted workspace. Each open sidebar tracks its own `workspaceId` and sends it on every tool call (`workbench_get_status`, `workbench_run_check`, `workbench_run_all`), so switching workspaces in conversation B never affects conversation A, and different workspaces run with independent locks.
- **No per-repo plugin copy needed**: Only `workbench.json` needs to live in each project repository (ignore `/.workbench/` in `.gitignore`).

### 2. Workspace-Scoped Installation (per-project isolated)

To install a project-bound copy directly into a single trusted workspace:

```sh
cd plugins/workbench-src
node scripts/install-workspace.mjs /path/to/your/workspace
```

The installer normalizes the workspace path with `realpath`, generates a deterministic per-workspace identity `workbench-<12-hex-sha256>` under `<workspace>/.agents/plugins/<plugin-name>/`, binds `--expected-root` in `mcp_config.json` (keeping `"command": "node"` so Antigravity falls back to its bundled Node.js), and sets a disambiguated sidebar menu title `Workbench (<dir> · <hash4>)`. In Workspace Mode, the global workspace selector card stays hidden and all checks run exclusively against the bound workspace root.

### Collaboration vs. local files

- **Commit to Git**: `workbench.json` (your project's acceptance checklist).
- **Keep local (`.gitignore`)**: `/.workbench/` (and `/.agents/plugins/workbench-*/` if using workspace-scoped installation). Because workspace-scoped `mcp_config.json` binds the machine's absolute real path, copying an installed directory to another workspace is rejected at startup.
- **Upgrading from `alpha.2`**: For workspace-scoped installs, remove legacy `.agents/plugins/workbench/` before running `install-workspace.mjs` (the installer stops and lists conflicting directories without mutating files). Existing `.workbench/last-run.json` files are left untouched; Workbench reads and writes `.workbench/results.json`.

## Configuration (`workbench.json`)

Place `workbench.json` in the workspace root:

```json
{
  "checks": [
    {
      "id": "format-total",
      "name": "1250 分显示为 ¥12.50",
      "command": ["node", "--test", "--test-isolation=none", "test/format-total.test.mjs"],
      "files": ["src/format-total.mjs", "test/format-total.test.mjs"],
      "timeoutMs": 15000
    },
    {
      "id": "clean-label",
      "name": "去除标签首尾空格",
      "command": ["node", "--test", "--test-isolation=none", "test/clean-label.test.mjs"],
      "files": ["src/clean-label.mjs", "test/clean-label.test.mjs"],
      "timeoutMs": 15000
    }
  ]
}
```

- `files` accepts explicit repo-relative paths only (absolute paths, `..` traversal, and symlinks escaping the workspace are rejected).
- `command` runs with `shell: false` at the bound workspace root. `"node"` reuses the active Node runtime (including Antigravity's bundled Electron/Node runtime); other executables resolve via the MCP server's `PATH` or explicit path. Trust/install only workspaces whose test commands you trust.

## Verified scope (`v0.2.0`)

- Dual-mode plugin (`global` + `workspace`) with `assets/logo.svg`, passing `agy plugin validate --strict` with zero errors, warnings, or notes.
- Verified on Antigravity desktop app **2.35.2** (bundled Node **v24.22.0**).
- Supported entrypoint: manual runs and failure-evidence attachment from the Antigravity desktop sidebar (`aux_pane`). All mutating and command-executing tools (`workbench_add_trusted_workspace`, `workbench_remove_trusted_workspace`, `workbench_run_check`, `workbench_run_all`) enforce a server-side MCP App UI-host capability gate (`io.modelcontextprotocol/ui` with `text/html;profile=mcp-app`), so non-UI hosts such as `agy` CLI are refused at the server level without modifying trusted workspaces or spawning commands.
- Deferred to future releases: directory globs, Git diff line counts, background jobs surviving pane close, opening source tabs, and Agent-initiated check runs.

[中文安装说明](plugins/workbench-src/README.md) · [桌面验收记录](docs/acceptance-report.md)
