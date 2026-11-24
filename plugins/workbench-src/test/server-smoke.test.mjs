import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const distPluginDir = path.join(repoRoot, 'dist', 'workbench');
const demoRoot = path.join(repoRoot, 'work', 'workbench-demo');

test('bundled dist/server.cjs serves full Phase 3 MCP App workflow over stdio', async () => {
  // Run against an isolated copy so smoke test never mutates work/workbench-demo/.workbench
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-stdio-e2e-'));
  const sandboxProject = path.join(tmpBase, 'demo-e2e');
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

  const installedPluginDir = path.join(sandboxProject, '.agents', 'plugins', 'workbench');
  fs.cpSync(distPluginDir, installedPluginDir, { recursive: true });
  const serverCjs = path.join(installedPluginDir, 'dist', 'server.cjs');
  const realSandboxProject = fs.realpathSync(sandboxProject);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverCjs],
    env: { ...process.env },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'workbench-e2e-test', version: '0.1.0' });
  await client.connect(transport);

  try {
    const toolsResp = await client.listTools();
    const byName = Object.fromEntries(toolsResp.tools.map((t) => [t.name, t]));

    assert.equal(byName.open_workbench?._meta?.ui?.resourceUri, 'ui://workbench/pane.html');
    assert.deepEqual(byName.open_workbench?._meta?.['com.google.antigravity/ui']?.entrypoints, [
      { type: 'aux_pane', title: 'Workbench' },
    ]);
    assert.deepEqual(byName.workbench_get_status?._meta?.ui?.visibility, ['app']);
    assert.deepEqual(byName.workbench_run_check?._meta?.ui?.visibility, ['app']);
    assert.deepEqual(byName.workbench_ping?._meta?.ui?.visibility, ['app']);

    const readResp = await client.readResource({ uri: 'ui://workbench/pane.html' });
    assert.equal(readResp.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.doesNotMatch(readResp.contents[0].text, /<script[^>]+src=/i);

    // 1. Initial not_run
    const openRes = await client.callTool({ name: 'open_workbench', arguments: {} });
    assert.equal(openRes.structuredContent?.effectiveState, 'not_run');
    assert.equal(openRes.structuredContent?.projectRoot, realSandboxProject);

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
