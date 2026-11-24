# Workbench for Antigravity

Workbench adds a local acceptance-check sidebar to the Antigravity desktop app. This prototype runs one bundled demo check, shows its result and evidence, and marks the result stale when the tracked source or test changes. The latest completed run is stored in the demo project's `.workbench/last-run.json`.

## Build and test

Use Node.js 24 and npm. From the repository root, run:

```sh
cd plugins/workbench-src
npm ci
npm run build
npm test
```

The build produces the self-contained plugin at `dist/workbench/` and installs a copy in `work/workbench-demo/.agents/plugins/workbench/`. The installed bundle uses Antigravity's bundled Node.js and needs no npm install.

## Try the demo

1. Open `work/workbench-demo/` as a project in Antigravity App. The prototype was verified on version 2.34.0.
2. Send a message in a conversation under the demo project to load its workspace plugins. In the conversation, open **More actions → Plugins → Workbench**.
3. Confirm that the sidebar's check directory is the demo project, then click **运行检查** (Run check). The result should be **通过** (Passed).
4. Change and save a comment in the demo's `src/format-total.mjs`. The sidebar should show **已过期** (Stale) and retain the preceding result. Run the check again to refresh the evidence.

The prototype runs the fixed `test/format-total.test.mjs` test and tracks that test and `src/format-total.mjs`. To try a second workspace, copy the demo source and test along with the plugin and omit `.workbench/`. Install the plugin only in workspaces whose test code you trust.

On Antigravity App 2.34.0, switching between projects with the same plugin name can reuse the prior workspace's MCP service. If the displayed directory is wrong, restart the App and open a conversation in the intended project before running a check.

[中文安装说明](plugins/workbench-src/README.md) · [桌面验收记录](docs/acceptance-report.md)
