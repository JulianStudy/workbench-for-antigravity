# Workbench for Antigravity

Workbench is a local MCP App for the Antigravity desktop app. The Phase 1 prototype verifies that the Workbench sidebar can connect to a local MCP server and show the project directory it resolved.

## Build and test

Use Node.js 24 and npm from the repository root.

```sh
cd plugins/workbench-src
npm ci
npm run build
npm test
```

The build writes the self-contained plugin to `dist/workbench/` at the repository root and places a copy in `work/workbench-demo/.agents/plugins/workbench/`.

## Open the sidebar

1. Open `work/workbench-demo/` as a project in Antigravity App 2.34.0 or later.
2. Start a conversation in that project. In the conversation's top menu, choose **More actions → Plugins → Workbench**.
3. Click **测试连接** (Test connection). The sidebar should show `workbench-ok` and the demo project's directory.

For a different workspace, copy the built `dist/workbench/` directory to that workspace's `.agents/plugins/workbench/`. Verify the displayed project directory after switching between workspaces with the same plugin installed.

See [Phase 1 verification](docs/phase-1.md) for the desktop test results and the workspace-switching limitation.
