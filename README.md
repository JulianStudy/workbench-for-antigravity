# Workbench for Antigravity

Workbench adds a local, workspace-isolated acceptance-check sidebar to the Antigravity desktop app. Each project defines its checks in `workbench.json` at the workspace root, runs checks individually or sequentially, tracks per-check staleness against tracked files and check config, persists each check's latest completed evidence to `.workbench/results.json` (`schemaVersion: 2`), and lets the user preview and explicitly attach a valid failure summary to the next conversation message via `app.updateModelContext()`.

## Build, test, and install

Use Node.js 24 and npm. From the repository root, run:

```sh
cd plugins/workbench-src
npm ci
npm run build
npm test
```

`npm run build` outputs the generic self-contained plugin template at `dist/workbench/` (zero runtime `node_modules`) and installs a workspace-bound copy into `work/workbench-demo/`.

To install Workbench into any trusted workspace:

```sh
cd plugins/workbench-src
node scripts/install-workspace.mjs /path/to/your/workspace
```

The installer normalizes the workspace path with `realpath`, generates a deterministic per-workspace identity `workbench-<12-hex-sha256>` under `<workspace>/.agents/plugins/<plugin-name>/`, binds `--expected-root` in `mcp_config.json` (keeping `"command": "node"` so Antigravity falls back to its bundled Node.js), and sets a disambiguated sidebar menu title `Workbench (<dir> · <hash4>)`.

Validate an installed directory with:

```sh
agy plugin validate <installed-plugin-dir> --strict
```

### Collaboration vs. local files

- **Commit to Git**: `workbench.json` (your project's acceptance checklist).
- **Keep local (`.gitignore`)**: `/.agents/plugins/workbench-*/` and `/.workbench/`. Because generated `mcp_config.json` binds the machine's absolute real path, each machine installs via `install-workspace.mjs`. Copying an installed directory to another workspace is rejected at startup.
- **Upgrading from `alpha.2`**: Remove legacy `.agents/plugins/workbench/` before running `install-workspace.mjs` (the installer stops and lists conflicting directories without mutating files). Existing `.workbench/last-run.json` files are left untouched; `alpha.3` reads and writes `.workbench/results.json`.

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
- `command` runs with `shell: false` at the bound workspace root. `"node"` reuses the active Node runtime (including Antigravity's bundled Electron/Node runtime); other executables resolve via the MCP server's `PATH` or explicit path. Install only in workspaces whose test code you trust.

## Verified scope (`v0.1.0-alpha.3` candidate)

- Verified on Antigravity desktop app **2.34.0** (`agy` CLI **1.5.16**, bundled Node **v24.22.0**).
- Supported entrypoint: manual runs and failure-evidence attachment from the Antigravity desktop sidebar (`aux_pane`). Antigravity CLI ignores some UI visibility metadata and is not a supported execution entrypoint.
- Deferred to future releases: directory globs, Git diff line counts, background jobs surviving pane close, opening source tabs, Agent-initiated check runs, and Marketplace publishing.

[中文安装说明](plugins/workbench-src/README.md) · [桌面验收记录](docs/acceptance-report.md)
