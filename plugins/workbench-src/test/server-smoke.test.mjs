import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const demoRoot = path.join(repoRoot, 'work', 'workbench-demo');
const serverCjs = path.join(demoRoot, '.agents', 'plugins', 'workbench', 'dist', 'server.cjs');

test('bundled dist/server.cjs boots over stdio and serves MCP App resource and tools', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverCjs],
    env: {
      ...process.env,
    },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'workbench-smoke-test', version: '0.1.0' });
  await client.connect(transport);

  try {
    const toolsResp = await client.listTools();
    const openTool = toolsResp.tools.find((t) => t.name === 'open_workbench');
    const pingTool = toolsResp.tools.find((t) => t.name === 'workbench_ping');

    assert.ok(openTool, 'open_workbench tool should be registered');
    assert.equal(openTool._meta?.ui?.resourceUri, 'ui://workbench/pane.html');
    assert.deepEqual(openTool._meta?.['com.google.antigravity/ui']?.entrypoints, [
      { type: 'aux_pane', title: 'Workbench' },
    ]);

    assert.ok(pingTool, 'workbench_ping tool should be registered');
    assert.deepEqual(pingTool._meta?.ui?.visibility, ['app']);

    const resourcesResp = await client.listResources();
    const paneRes = resourcesResp.resources.find((r) => r.uri === 'ui://workbench/pane.html');
    assert.ok(paneRes, 'ui://workbench/pane.html resource should be listed');
    assert.equal(paneRes.mimeType, 'text/html;profile=mcp-app');

    const readResp = await client.readResource({ uri: 'ui://workbench/pane.html' });
    assert.equal(readResp.contents.length, 1);
    assert.equal(readResp.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.match(readResp.contents[0].text, /<script>/);
    assert.doesNotMatch(readResp.contents[0].text, /<script[^>]+src=/i);

    const openRes = await client.callTool({ name: 'open_workbench', arguments: {} });
    assert.equal(openRes.structuredContent?.ok, true);
    assert.equal(openRes.structuredContent?.projectRoot, demoRoot);

    const pingRes = await client.callTool({ name: 'workbench_ping', arguments: {} });
    assert.equal(pingRes.structuredContent?.ok, true);
    assert.equal(pingRes.structuredContent?.pong, 'workbench-ok');
    assert.equal(pingRes.structuredContent?.projectRoot, demoRoot);
    assert.equal(pingRes.structuredContent?.nodeVersion, process.version);
  } finally {
    await client.close();
  }
});
