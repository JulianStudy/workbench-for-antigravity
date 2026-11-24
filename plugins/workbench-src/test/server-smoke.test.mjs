import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installWorkspacePlugin } from '../scripts/install-workspace.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const distPluginDir = path.join(repoRoot, 'dist', 'workbench');
const demoRoot = path.join(repoRoot, 'work', 'workbench-demo');

function createSandboxProject(tmpBase, name = 'demo-e2e') {
  const sandboxProject = path.join(tmpBase, name);
  fs.mkdirSync(path.join(sandboxProject, 'src'), { recursive: true });
  fs.mkdirSync(path.join(sandboxProject, 'test'), { recursive: true });
  fs.copyFileSync(
    path.join(demoRoot, 'src', 'format-total.mjs'),
    path.join(sandboxProject, 'src', 'format-total.mjs')
  );
  fs.copyFileSync(
    path.join(demoRoot, 'test', 'format-total.test.mjs'),
    path.join(sandboxProject, 'test', 'format-total.test.mjs')
  );
  return sandboxProject;
}

async function connectStdioServer(args) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: { ...process.env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'workbench-e2e-test', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

test('bundled dist/server.cjs serves full workspace-bound MCP App workflow over stdio', async () => {
  // Run against an isolated copy so smoke test never mutates work/workbench-demo/.workbench
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-stdio-e2e-'));
  const sandboxProject = createSandboxProject(tmpBase, 'demo-e2e');

  const installed = installWorkspacePlugin(sandboxProject, { distPluginDir });
  const mcpConfig = JSON.parse(
    fs.readFileSync(path.join(installed.installDir, 'mcp_config.json'), 'utf8')
  );
  const resolvedArgs = mcpConfig.mcpServers.workbench_runner.args.map((arg) =>
    arg.replace('${PLUGIN_ROOT}', installed.installDir)
  );

  const client = await connectStdioServer(resolvedArgs);

  try {
    const toolsResp = await client.listTools();
    const byName = Object.fromEntries(toolsResp.tools.map((t) => [t.name, t]));

    assert.equal(byName.open_workbench?.title, installed.entryTitle);
    assert.equal(byName.open_workbench?._meta?.ui?.resourceUri, 'ui://workbench/pane.html');
    assert.deepEqual(byName.open_workbench?._meta?.['com.google.antigravity/ui']?.entrypoints, [
      { type: 'aux_pane', title: installed.entryTitle },
    ]);
    assert.deepEqual(byName.workbench_get_status?._meta?.ui?.visibility, ['app']);
    assert.deepEqual(byName.workbench_run_check?._meta?.ui?.visibility, ['app']);
    assert.deepEqual(byName.workbench_ping?._meta?.ui?.visibility, ['app']);

    const readResp = await client.readResource({ uri: 'ui://workbench/pane.html' });
    assert.equal(readResp.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.doesNotMatch(readResp.contents[0].text, /<script[^>]+src=/i);

    // 1. Initial not_run
    const openRes = await client.callTool({ name: 'open_workbench', arguments: {} });
    assert.equal(openRes.structuredContent?.ok, true);
    assert.equal(openRes.structuredContent?.effectiveState, 'not_run');
    assert.equal(openRes.structuredContent?.projectRoot, installed.realRoot);

    // 2. Run check -> passed
    const runRes = await client.callTool({ name: 'workbench_run_check', arguments: {} });
    assert.equal(runRes.structuredContent?.busy, false);
    assert.equal(runRes.structuredContent?.effectiveState, 'passed');
    assert.equal(runRes.structuredContent?.lastRun?.exitCode, 0);

    // 3. Edit comment -> get_status reports stale with changed file & keeps passed history
    const srcPath = path.join(sandboxProject, 'src', 'format-total.mjs');
    const origSrc = fs.readFileSync(srcPath, 'utf8');
    fs.writeFileSync(srcPath, `// touch comment\n${origSrc}`, 'utf8');

    const staleRes = await client.callTool({ name: 'workbench_get_status', arguments: {} });
    assert.equal(staleRes.structuredContent?.effectiveState, 'stale');
    assert.equal(staleRes.structuredContent?.lastRun?.status, 'passed');
    assert.deepEqual(staleRes.structuredContent?.changedFiles, ['src/format-total.mjs']);

    // 4. Re-run -> passed again with updated evidence
    const rerunRes = await client.callTool({ name: 'workbench_run_check', arguments: {} });
    assert.equal(rerunRes.structuredContent?.effectiveState, 'passed');
    assert.deepEqual(rerunRes.structuredContent?.changedFiles, []);
  } finally {
    await client.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('bundled dist/server.cjs disables execution when unbound or when --expected-root mismatches', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-stdio-guard-'));
  const workspaceA = createSandboxProject(tmpBase, 'workspace-a');
  const workspaceB = createSandboxProject(tmpBase, 'workspace-b');

  try {
    const installedA = installWorkspacePlugin(workspaceA, { distPluginDir });
    const serverCjsA = path.join(installedA.installDir, 'dist', 'server.cjs');

    // Case 1: Unbound server (missing --expected-root)
    const unboundClient = await connectStdioServer([serverCjsA]);
    try {
      const toolsResp = await unboundClient.listTools();
      const openTool = toolsResp.tools.find((t) => t.name === 'open_workbench');
      assert.deepEqual(openTool?._meta?.['com.google.antigravity/ui']?.entrypoints, [
        { type: 'aux_pane', title: 'Workbench' },
      ]);

      const openRes = await unboundClient.callTool({ name: 'open_workbench', arguments: {} });
      assert.equal(openRes.structuredContent?.ok, false);
      assert.equal(openRes.structuredContent?.effectiveState, 'error');
      assert.match(openRes.structuredContent?.rootError || '', /--expected-root/);

      const runRes = await unboundClient.callTool({ name: 'workbench_run_check', arguments: {} });
      assert.equal(runRes.structuredContent?.ok, false);
      assert.equal(runRes.structuredContent?.busy, false);
      assert.equal(fs.existsSync(path.join(workspaceA, '.workbench')), false);
    } finally {
      await unboundClient.close();
    }

    // Case 2: Copied plugin from workspaceA into workspaceB with workspaceA's binding
    const copiedPluginB = path.join(workspaceB, '.agents', 'plugins', installedA.pluginName);
    fs.mkdirSync(path.dirname(copiedPluginB), { recursive: true });
    fs.cpSync(installedA.installDir, copiedPluginB, { recursive: true });
    const copiedMcpConfig = JSON.parse(
      fs.readFileSync(path.join(copiedPluginB, 'mcp_config.json'), 'utf8')
    );
    const copiedArgs = copiedMcpConfig.mcpServers.workbench_runner.args.map((arg) =>
      arg.replace('${PLUGIN_ROOT}', copiedPluginB)
    );

    const mismatchClient = await connectStdioServer(copiedArgs);
    try {
      const openRes = await mismatchClient.callTool({ name: 'open_workbench', arguments: {} });
      assert.equal(openRes.structuredContent?.ok, false);
      assert.equal(openRes.structuredContent?.effectiveState, 'error');
      assert.ok(openRes.structuredContent?.rootError?.includes(installedA.realRoot));

      const runRes = await mismatchClient.callTool({ name: 'workbench_run_check', arguments: {} });
      assert.equal(runRes.structuredContent?.ok, false);
      assert.equal(runRes.structuredContent?.busy, false);
      assert.equal(fs.existsSync(path.join(workspaceB, '.workbench')), false);
    } finally {
      await mismatchClient.close();
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
