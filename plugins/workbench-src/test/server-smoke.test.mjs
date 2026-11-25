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
    path.join(demoRoot, 'workbench.json'),
    path.join(sandboxProject, 'workbench.json')
  );
  fs.copyFileSync(
    path.join(demoRoot, 'src', 'format-total.mjs'),
    path.join(sandboxProject, 'src', 'format-total.mjs')
  );
  fs.copyFileSync(
    path.join(demoRoot, 'test', 'format-total.test.mjs'),
    path.join(sandboxProject, 'test', 'format-total.test.mjs')
  );
  fs.copyFileSync(
    path.join(demoRoot, 'src', 'clean-label.mjs'),
    path.join(sandboxProject, 'src', 'clean-label.mjs')
  );
  fs.copyFileSync(
    path.join(demoRoot, 'test', 'clean-label.test.mjs'),
    path.join(sandboxProject, 'test', 'clean-label.test.mjs')
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

test('bundled dist/server.cjs serves multi-check workspace-bound MCP App workflow with payload isolation over stdio', async () => {
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
    assert.deepEqual(byName.workbench_run_all?._meta?.ui?.visibility, ['app']);
    assert.deepEqual(byName.workbench_ping?._meta?.ui?.visibility, ['app']);
    assert.ok(byName.workbench_run_check?.inputSchema?.required?.includes('id'));

    const readResp = await client.readResource({ uri: 'ui://workbench/pane.html' });
    assert.equal(readResp.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.doesNotMatch(readResp.contents[0].text, /<script[^>]+src=/i);

    // 1. Initial open_workbench -> both checks not_run
    const openRes = await client.callTool({ name: 'open_workbench', arguments: {} });
    assert.equal(openRes.structuredContent?.ok, true);
    assert.equal(openRes.structuredContent?.configOk, true);
    assert.equal(openRes.structuredContent?.projectRoot, installed.realRoot);
    assert.deepEqual(openRes.structuredContent?.counts, {
      total: 2,
      not_run: 2,
      passed: 0,
      failed: 0,
      stale: 0,
      error: 0,
    });

    // 2. Run all -> both checks pass
    const runAllRes = await client.callTool({ name: 'workbench_run_all', arguments: {} });
    assert.equal(runAllRes.structuredContent?.busy, false);
    assert.equal(runAllRes.structuredContent?.counts?.passed, 2);

    // 3. Payload isolation: open_workbench and workbench_get_status({}) omit output completely
    const openAfterRun = await client.callTool({ name: 'open_workbench', arguments: {} });
    const openText = openAfterRun.content?.[0]?.text || '';
    assert.doesNotMatch(openText, /1250 分显示为 ¥12\.50|TAP version|duration_ms/);
    for (const check of openAfterRun.structuredContent?.checks || []) {
      assert.equal(check.lastRun?.hasOutput, true);
      assert.equal('output' in (check.lastRun || {}), false, 'open_workbench must omit output');
    }

    const summaryRes = await client.callTool({ name: 'workbench_get_status', arguments: {} });
    for (const check of summaryRes.structuredContent?.checks || []) {
      assert.equal(check.lastRun?.hasOutput, true);
      assert.equal('output' in (check.lastRun || {}), false, 'summary status must omit output');
    }

    // 4. On-demand detail fetch returns full output for the requested check ID
    const detailFmt = await client.callTool({
      name: 'workbench_get_status',
      arguments: { id: 'format-total' },
    });
    assert.equal(detailFmt.structuredContent?.ok, true);
    assert.equal(detailFmt.structuredContent?.check?.id, 'format-total');
    assert.match(detailFmt.structuredContent?.check?.lastRun?.output || '', /1250 分显示为 ¥12\.50/);

    const detailLbl = await client.callTool({
      name: 'workbench_get_status',
      arguments: { id: 'clean-label' },
    });
    assert.equal(detailLbl.structuredContent?.ok, true);
    assert.match(detailLbl.structuredContent?.check?.lastRun?.output || '', /去除标签首尾空格/);

    // 5. File edit isolates staleness to format-total only
    const srcPath = path.join(sandboxProject, 'src', 'format-total.mjs');
    const origSrc = fs.readFileSync(srcPath, 'utf8');
    fs.writeFileSync(srcPath, `// touch comment\n${origSrc}`, 'utf8');

    const staleRes = await client.callTool({ name: 'workbench_get_status', arguments: {} });
    const fmtAfterEdit = staleRes.structuredContent?.checks?.find((c) => c.id === 'format-total');
    const lblAfterEdit = staleRes.structuredContent?.checks?.find((c) => c.id === 'clean-label');
    assert.equal(fmtAfterEdit?.effectiveState, 'stale');
    assert.equal(fmtAfterEdit?.staleReason, 'files_changed_after_run');
    assert.deepEqual(fmtAfterEdit?.changedFiles, ['src/format-total.mjs']);
    assert.equal(lblAfterEdit?.effectiveState, 'passed');

    // 6. Single-check run restores format-total to passed
    const rerunRes = await client.callTool({
      name: 'workbench_run_check',
      arguments: { id: 'format-total' },
    });
    assert.equal(rerunRes.structuredContent?.busy, false);
    assert.equal(rerunRes.structuredContent?.ranCheckId, 'format-total');
    assert.equal(rerunRes.structuredContent?.counts?.passed, 2);

    // 7. Config change on clean-label marks ONLY clean-label stale (config_changed)
    const cfgPath = path.join(sandboxProject, 'workbench.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.checks[1].timeoutMs = 20000;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    const cfgStaleRes = await client.callTool({ name: 'workbench_get_status', arguments: {} });
    const fmtAfterCfg = cfgStaleRes.structuredContent?.checks?.find((c) => c.id === 'format-total');
    const lblAfterCfg = cfgStaleRes.structuredContent?.checks?.find((c) => c.id === 'clean-label');
    assert.equal(fmtAfterCfg?.effectiveState, 'passed');
    assert.equal(lblAfterCfg?.effectiveState, 'stale');
    assert.equal(lblAfterCfg?.staleReason, 'config_changed');
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

      const runRes = await unboundClient.callTool({
        name: 'workbench_run_check',
        arguments: { id: 'format-total' },
      });
      assert.equal(runRes.structuredContent?.ok, false);
      assert.equal(runRes.structuredContent?.busy, false);

      const runAllRes = await unboundClient.callTool({ name: 'workbench_run_all', arguments: {} });
      assert.equal(runAllRes.structuredContent?.ok, false);
      assert.equal(runAllRes.structuredContent?.busy, false);
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

      const runRes = await mismatchClient.callTool({
        name: 'workbench_run_check',
        arguments: { id: 'format-total' },
      });
      assert.equal(runRes.structuredContent?.ok, false);
      assert.equal(runRes.structuredContent?.busy, false);

      const runAllRes = await mismatchClient.callTool({ name: 'workbench_run_all', arguments: {} });
      assert.equal(runAllRes.structuredContent?.ok, false);
      assert.equal(runAllRes.structuredContent?.busy, false);
      assert.equal(fs.existsSync(path.join(workspaceB, '.workbench')), false);
    } finally {
      await mismatchClient.close();
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('open_workbench isolates check output across both content and structuredContent even after failing/passing runs with unique markers', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-stdio-iso-'));
  const sandboxProject = createSandboxProject(tmpBase, 'demo-iso');
  const UNIQUE_MARKER = 'UNIQUE_OUTPUT_MARKER_ALPHA3_9f8e7d';

  // Inject unique output markers into both test files (and force clean-label to fail)
  const fmtTestPath = path.join(sandboxProject, 'test', 'format-total.test.mjs');
  fs.writeFileSync(
    fmtTestPath,
    `${fs.readFileSync(fmtTestPath, 'utf8')}\nconsole.log('${UNIQUE_MARKER}_PASS');\n`,
    'utf8'
  );
  const lblTestPath = path.join(sandboxProject, 'test', 'clean-label.test.mjs');
  fs.writeFileSync(
    lblTestPath,
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('forced failure with unique marker', () => {",
      `  console.error('${UNIQUE_MARKER}_FAIL');`,
      `  assert.equal('actual', 'expected_${UNIQUE_MARKER}');`,
      '});',
      '',
    ].join('\n'),
    'utf8'
  );

  const installed = installWorkspacePlugin(sandboxProject, { distPluginDir });
  const mcpConfig = JSON.parse(
    fs.readFileSync(path.join(installed.installDir, 'mcp_config.json'), 'utf8')
  );
  const resolvedArgs = mcpConfig.mcpServers.workbench_runner.args.map((arg) =>
    arg.replace('${PLUGIN_ROOT}', installed.installDir)
  );

  const client = await connectStdioServer(resolvedArgs);
  try {
    // Verify bundled pane.html includes Stage 3 failure evidence preview & explicit attach UI
    const uiRes = await client.readResource({ uri: 'ui://workbench/pane.html' });
    const html = uiRes.contents[0]?.text || '';
    assert.ok(html.includes('evidence-preview'), 'pane.html must include selectable evidence-preview styles');
    assert.ok(html.includes('buildFailureEvidencePreview'), 'pane.html must bundle failure evidence preview builder');
    assert.ok(html.includes('attachFailureEvidenceContext'), 'pane.html must bundle explicit updateModelContext helper');
    assert.ok(html.includes('confirmAttachFailureEvidence'), 'pane.html must bundle explicit confirm attach handler');

    const runAllRes = await client.callTool({ name: 'workbench_run_all', arguments: {} });
    assert.equal(runAllRes.structuredContent?.counts?.passed, 1);
    assert.equal(runAllRes.structuredContent?.counts?.failed, 1);

    const openRes = await client.callTool({ name: 'open_workbench', arguments: {} });
    const openContentJson = JSON.stringify(openRes.content);
    const openStructuredJson = JSON.stringify(openRes.structuredContent);

    assert.equal(
      openContentJson.includes(UNIQUE_MARKER),
      false,
      'open_workbench content must not contain test output marker'
    );
    assert.equal(
      openStructuredJson.includes(UNIQUE_MARKER),
      false,
      'open_workbench structuredContent must not contain test output marker'
    );
    assert.equal(
      openContentJson.includes('1250 分显示为 ¥12.50'),
      false,
      'open_workbench content must not contain raw test output lines'
    );
    assert.equal(
      /"output"\s*:/.test(openStructuredJson),
      false,
      'open_workbench structuredContent must contain zero output fields'
    );
    for (const check of openRes.structuredContent?.checks || []) {
      assert.equal('output' in (check.lastRun || {}), false);
    }

    const summaryRes = await client.callTool({ name: 'workbench_get_status', arguments: {} });
    const summaryJson = JSON.stringify(summaryRes.structuredContent);
    assert.equal(summaryJson.includes(UNIQUE_MARKER), false);
    assert.equal(/"output"\s*:/.test(summaryJson), false);
    for (const check of summaryRes.structuredContent?.checks || []) {
      assert.equal('output' in (check.lastRun || {}), false);
    }

    const passDetail = await client.callTool({
      name: 'workbench_get_status',
      arguments: { id: 'format-total' },
    });
    assert.ok(
      (passDetail.structuredContent?.check?.lastRun?.output || '').includes(`${UNIQUE_MARKER}_PASS`),
      'workbench_get_status({ id }) must return full output for passing check'
    );

    const failDetail = await client.callTool({
      name: 'workbench_get_status',
      arguments: { id: 'clean-label' },
    });
    assert.equal(failDetail.structuredContent?.check?.effectiveState, 'failed');
    assert.ok(
      (failDetail.structuredContent?.check?.lastRun?.output || '').includes(`${UNIQUE_MARKER}_FAIL`),
      'workbench_get_status({ id }) must return full output for failing check'
    );
  } finally {
    await client.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
