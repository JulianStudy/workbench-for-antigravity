import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installWorkspacePlugin } from '../scripts/install-workspace.mjs';
import {
  isUiCapableClient,
  parseServerArgs,
  resolveServerMode,
  UI_HOST_REQUIRED_ERROR,
} from '../src/server.mjs';
import { addTrustedWorkspace, getTrustedWorkspacesFilePath } from '../src/workspaces.mjs';

const UI_HOST_CAPABILITIES = {
  extensions: {
    'io.modelcontextprotocol/ui': {
      mimeTypes: ['text/html;profile=mcp-app'],
    },
  },
};

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

async function connectStdioServer(args, envOverrides = null, { uiCapable = true } = {}) {
  const env = { ...process.env };
  if (envOverrides) {
    for (const [key, val] of Object.entries(envOverrides)) {
      if (val === undefined) {
        delete env[key];
      } else {
        env[key] = val;
      }
    }
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env,
    stderr: 'pipe',
  });
  const client = uiCapable
    ? new Client(
        { name: 'workbench-e2e-test', version: '0.1.0' },
        { capabilities: UI_HOST_CAPABILITIES }
      )
    : new Client({ name: 'workbench-non-ui-test', version: '0.1.0' });
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

test('parseServerArgs and resolveServerMode handle dual-mode flags and global/workspace detection', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dual-mode-'));
  const origPluginData = process.env.PLUGIN_DATA;
  try {
    assert.deepEqual(
      parseServerArgs(['--plugin-data', '/tmp/wb-data', '--mode', 'global']),
      { expectedRoot: null, entryTitle: 'Workbench', pluginDataDir: '/tmp/wb-data', mode: 'global' }
    );
    assert.deepEqual(
      parseServerArgs(['--plugin-data=/tmp/wb-data-2', '--mode=workspace']),
      {
        expectedRoot: null,
        entryTitle: 'Workbench',
        pluginDataDir: '/tmp/wb-data-2',
        mode: 'workspace',
      }
    );

    const projectRoot = path.join(tmpBase, 'proj');
    const wsPluginDir = path.join(projectRoot, '.agents', 'plugins', 'workbench-0123456789ab');
    const globalPluginDir = path.join(tmpBase, '.gemini', 'config', 'plugins', 'workbench');
    const dataDir = path.join(tmpBase, 'data-dir');
    const blockingFile = path.join(tmpBase, 'not-a-dir');
    fs.mkdirSync(wsPluginDir, { recursive: true });
    fs.mkdirSync(globalPluginDir, { recursive: true });
    fs.writeFileSync(blockingFile, 'file', 'utf8');

    // Workspace-scoped with expectedRoot -> workspace mode ok
    const wsOk = resolveServerMode({ pluginDir: wsPluginDir, expectedRoot: projectRoot });
    assert.equal(wsOk.ok, true);
    assert.equal(wsOk.mode, 'workspace');
    assert.equal(wsOk.projectRoot, fs.realpathSync(projectRoot));

    // Workspace-scoped without expectedRoot -> workspace mode fail
    const wsMissing = resolveServerMode({ pluginDir: wsPluginDir, expectedRoot: null });
    assert.equal(wsMissing.ok, false);
    assert.equal(wsMissing.mode, 'workspace');
    assert.match(wsMissing.rootError || '', /--expected-root/);

    // Global install with explicit pluginDataDir -> global mode ok
    delete process.env.PLUGIN_DATA;
    const globalOk = resolveServerMode({ pluginDir: globalPluginDir, pluginDataDir: dataDir });
    assert.equal(globalOk.ok, true);
    assert.equal(globalOk.mode, 'global');
    assert.equal(globalOk.pluginDataDir, fs.realpathSync(dataDir));
    assert.equal(globalOk.rootError, null);

    // Global install without pluginDataDir or PLUGIN_DATA -> global mode fail
    const globalMissingData = resolveServerMode({ pluginDir: globalPluginDir });
    assert.equal(globalMissingData.ok, false);
    assert.equal(globalMissingData.mode, 'global');
    assert.match(globalMissingData.rootError || '', /PLUGIN_DATA/);

    // Global install with file as pluginDataDir -> global mode fail
    const globalBadData = resolveServerMode({
      pluginDir: globalPluginDir,
      pluginDataDir: blockingFile,
    });
    assert.equal(globalBadData.ok, false);
    assert.equal(globalBadData.mode, 'global');

    // Global install with PLUGIN_DATA env fallback -> global mode ok
    process.env.PLUGIN_DATA = dataDir;
    const globalEnvOk = resolveServerMode({ pluginDir: globalPluginDir });
    assert.equal(globalEnvOk.ok, true);
    assert.equal(globalEnvOk.mode, 'global');
    assert.equal(globalEnvOk.pluginDataDir, fs.realpathSync(dataDir));

    // Explicit mode=global overrides workspace pluginDir
    const forcedGlobal = resolveServerMode({
      pluginDir: wsPluginDir,
      pluginDataDir: dataDir,
      mode: 'global',
    });
    assert.equal(forcedGlobal.ok, true);
    assert.equal(forcedGlobal.mode, 'global');
  } finally {
    if (origPluginData === undefined) {
      delete process.env.PLUGIN_DATA;
    } else {
      process.env.PLUGIN_DATA = origPluginData;
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('bundled dist/server.cjs in Global Mode supports stateless multi-workspace binding, payload isolation, concurrent independent locks, and strict refusal when unbound', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-global-stdio-'));
  const fakeGlobalInstall = path.join(tmpBase, '.gemini', 'config', 'plugins', 'workbench');
  const pluginDataDir = path.join(tmpBase, '.gemini', 'config', 'plugin-data', 'workbench');
  fs.mkdirSync(path.dirname(fakeGlobalInstall), { recursive: true });
  fs.cpSync(distPluginDir, fakeGlobalInstall, { recursive: true });

  const workspaceA = createSandboxProject(tmpBase, 'workspace-alpha');
  const workspaceB = createSandboxProject(tmpBase, 'workspace-beta');
  const untrustedWorkspace = createSandboxProject(tmpBase, 'workspace-untrusted');

  // Inject unique marker in workspaceA to verify global-mode open_workbench output isolation
  const UNIQUE_GLOBAL_MARKER = 'GLOBAL_ISO_MARKER_7c4a91';
  const fmtTestA = path.join(workspaceA, 'test', 'format-total.test.mjs');
  fs.writeFileSync(
    fmtTestA,
    `${fs.readFileSync(fmtTestA, 'utf8')}\nconsole.log('${UNIQUE_GLOBAL_MARKER}');\n`,
    'utf8'
  );

  // Add a slow check to workspaceA for concurrent lock + busy-remove test
  const cfgPathA = path.join(workspaceA, 'workbench.json');
  const cfgA = JSON.parse(fs.readFileSync(cfgPathA, 'utf8'));
  cfgA.checks.push({
    id: 'slow-a',
    name: '慢速检查 A',
    command: ['node', '-e', 'setTimeout(() => process.exit(0), 350)'],
    files: ['src/format-total.mjs'],
    timeoutMs: 10000,
  });
  fs.writeFileSync(cfgPathA, JSON.stringify(cfgA, null, 2), 'utf8');

  // Simulate Marketplace mcp_config.json expansion
  const mcpConfig = JSON.parse(
    fs.readFileSync(path.join(fakeGlobalInstall, 'mcp_config.json'), 'utf8')
  );
  const resolvedArgs = mcpConfig.mcpServers.workbench_runner.args.map((arg) =>
    arg
      .replace('${PLUGIN_ROOT}', fakeGlobalInstall)
      .replace('${PLUGIN_DATA}', pluginDataDir)
  );

  const client = await connectStdioServer(resolvedArgs, { PLUGIN_DATA: undefined });
  try {
    // 1. Tool registration & visibility
    const toolsResp = await client.listTools();
    const byName = Object.fromEntries(toolsResp.tools.map((t) => [t.name, t]));
    assert.deepEqual(byName.workbench_add_trusted_workspace?._meta?.ui?.visibility, ['app']);
    assert.deepEqual(byName.workbench_remove_trusted_workspace?._meta?.ui?.visibility, ['app']);

    // 2. Ping & open_workbench in unbound global mode
    const pingRes = await client.callTool({ name: 'workbench_ping', arguments: {} });
    assert.equal(pingRes.structuredContent?.ok, true);
    assert.equal(pingRes.structuredContent?.mode, 'global');
    assert.equal(pingRes.structuredContent?.pong, 'workbench-ok');
    assert.equal(pingRes.structuredContent?.uiHostCapable, true);

    const openUnbound = await client.callTool({ name: 'open_workbench', arguments: {} });
    assert.equal(openUnbound.structuredContent?.ok, true);
    assert.equal(openUnbound.structuredContent?.mode, 'global');
    assert.equal(openUnbound.structuredContent?.workspaceBound, false);
    assert.equal(openUnbound.structuredContent?.projectRoot, null);
    assert.deepEqual(openUnbound.structuredContent?.trustedWorkspaces, []);
    assert.deepEqual(openUnbound.structuredContent?.checks, []);

    // 3. Unbound / untrusted / raw-path execution MUST be refused without spawning
    const runMissingId = await client.callTool({
      name: 'workbench_run_check',
      arguments: { id: 'format-total' },
    });
    assert.equal(runMissingId.structuredContent?.ok, false);
    assert.equal(runMissingId.structuredContent?.workspaceBound, false);
    assert.equal(runMissingId.structuredContent?.busy, false);

    const runRawPath = await client.callTool({
      name: 'workbench_run_check',
      arguments: { id: 'format-total', workspaceId: untrustedWorkspace },
    });
    assert.equal(runRawPath.structuredContent?.ok, false);
    assert.equal(runRawPath.structuredContent?.workspaceBound, false);
    assert.equal(runRawPath.structuredContent?.busy, false);

    const runAllUntrusted = await client.callTool({
      name: 'workbench_run_all',
      arguments: { workspaceId: 'deadbeef0000' },
    });
    assert.equal(runAllUntrusted.structuredContent?.ok, false);
    assert.equal(runAllUntrusted.structuredContent?.workspaceBound, false);
    assert.equal(fs.existsSync(path.join(untrustedWorkspace, '.workbench')), false);

    // Untrusted workspaceId in workbench_get_status returns bindingError
    const statusUntrusted = await client.callTool({
      name: 'workbench_get_status',
      arguments: { workspaceId: 'deadbeef0000' },
    });
    assert.equal(statusUntrusted.structuredContent?.ok, true);
    assert.equal(statusUntrusted.structuredContent?.workspaceBound, false);
    assert.ok(statusUntrusted.structuredContent?.bindingError);

    // 4. Add trusted workspaces (reject filesystem root & missing path cleanly)
    const addRootErr = await client.callTool({
      name: 'workbench_add_trusted_workspace',
      arguments: { workspacePath: path.parse(tmpBase).root },
    });
    assert.equal(addRootErr.structuredContent?.ok, false);
    assert.ok(addRootErr.structuredContent?.error);

    const addA = await client.callTool({
      name: 'workbench_add_trusted_workspace',
      arguments: { workspacePath: workspaceA },
    });
    assert.equal(addA.structuredContent?.ok, true);
    assert.equal(addA.structuredContent?.mode, 'global');
    const idA = addA.structuredContent?.addedWorkspace?.id;
    assert.match(idA || '', /^[0-9a-f]{12}$/);
    assert.equal(addA.structuredContent?.addedWorkspace?.exists, true);
    assert.equal(addA.structuredContent?.addedWorkspace?.hasConfig, true);

    const addB = await client.callTool({
      name: 'workbench_add_trusted_workspace',
      arguments: { workspacePath: workspaceB },
    });
    assert.equal(addB.structuredContent?.ok, true);
    const idB = addB.structuredContent?.addedWorkspace?.id;
    assert.notEqual(idA, idB);
    assert.equal(addB.structuredContent?.trustedWorkspaces?.length, 2);

    // 5. Stateless per-pane isolation: run check in A, verify B stays not_run, and vice versa
    const runA = await client.callTool({
      name: 'workbench_run_check',
      arguments: { id: 'format-total', workspaceId: idA },
    });
    assert.equal(runA.structuredContent?.ok, true);
    assert.equal(runA.structuredContent?.mode, 'global');
    assert.equal(runA.structuredContent?.workspaceBound, true);
    assert.equal(runA.structuredContent?.selectedWorkspace?.id, idA);
    assert.equal(runA.structuredContent?.counts?.passed, 1);

    const statusB = await client.callTool({
      name: 'workbench_get_status',
      arguments: { workspaceId: idB },
    });
    assert.equal(statusB.structuredContent?.workspaceBound, true);
    assert.equal(statusB.structuredContent?.selectedWorkspace?.id, idB);
    assert.equal(statusB.structuredContent?.counts?.passed, 0);
    assert.equal(statusB.structuredContent?.counts?.not_run, 2);

    // Payload isolation in global mode
    const statusA = await client.callTool({
      name: 'workbench_get_status',
      arguments: { workspaceId: idA },
    });
    const statusAJson = JSON.stringify(statusA.structuredContent);
    assert.equal(statusAJson.includes(UNIQUE_GLOBAL_MARKER), false);
    assert.equal(/"output"\s*:/.test(statusAJson), false);

    const detailA = await client.callTool({
      name: 'workbench_get_status',
      arguments: { workspaceId: idA, id: 'format-total' },
    });
    assert.ok(
      (detailA.structuredContent?.check?.lastRun?.output || '').includes(UNIQUE_GLOBAL_MARKER)
    );

    // open_workbench remains strictly summary-only (zero check output)
    const openAfterRuns = await client.callTool({ name: 'open_workbench', arguments: {} });
    const openAfterText = JSON.stringify(openAfterRuns.content);
    const openAfterStruct = JSON.stringify(openAfterRuns.structuredContent);
    assert.equal(openAfterText.includes(UNIQUE_GLOBAL_MARKER), false);
    assert.equal(openAfterStruct.includes(UNIQUE_GLOBAL_MARKER), false);
    assert.equal(/"output"\s*:/.test(openAfterStruct), false);
    assert.equal(openAfterRuns.structuredContent?.trustedWorkspaces?.length, 2);

    // 6. Independent locks across workspaces + busy refusal on remove
    const slowRunAPromise = client.callTool({
      name: 'workbench_run_check',
      arguments: { id: 'slow-a', workspaceId: idA },
    });
    await new Promise((r) => setTimeout(r, 60));

    // Workspace B runs concurrently without being blocked by Workspace A
    const runBConcurrent = await client.callTool({
      name: 'workbench_run_check',
      arguments: { id: 'clean-label', workspaceId: idB },
    });
    assert.equal(runBConcurrent.structuredContent?.busy, false);
    assert.equal(runBConcurrent.structuredContent?.counts?.passed, 1);

    // Removing Workspace A while running MUST be refused with busy: true
    const removeWhileBusy = await client.callTool({
      name: 'workbench_remove_trusted_workspace',
      arguments: { workspaceId: idA },
    });
    assert.equal(removeWhileBusy.structuredContent?.ok, false);
    assert.equal(removeWhileBusy.structuredContent?.busy, true);

    const slowRunARes = await slowRunAPromise;
    assert.equal(slowRunARes.structuredContent?.busy, false);

    // Now remove Workspace A succeeds and blocks future runs on idA
    const removeDone = await client.callTool({
      name: 'workbench_remove_trusted_workspace',
      arguments: { workspaceId: idA },
    });
    assert.equal(removeDone.structuredContent?.ok, true);
    assert.equal(removeDone.structuredContent?.removed, true);
    assert.deepEqual(
      removeDone.structuredContent?.trustedWorkspaces?.map((w) => w.id),
      [idB]
    );

    const runAAfterRemove = await client.callTool({
      name: 'workbench_run_check',
      arguments: { id: 'format-total', workspaceId: idA },
    });
    assert.equal(runAAfterRemove.structuredContent?.ok, false);
    assert.equal(runAAfterRemove.structuredContent?.workspaceBound, false);
  } finally {
    await client.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('bundled dist/server.cjs in Global Mode disables execution when PLUGIN_DATA is missing', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-global-nodata-'));
  const fakeGlobalInstall = path.join(tmpBase, '.gemini', 'config', 'plugins', 'workbench');
  fs.mkdirSync(path.dirname(fakeGlobalInstall), { recursive: true });
  fs.cpSync(distPluginDir, fakeGlobalInstall, { recursive: true });

  const serverCjs = path.join(fakeGlobalInstall, 'dist', 'server.cjs');
  const client = await connectStdioServer([serverCjs], { PLUGIN_DATA: undefined });
  try {
    const openRes = await client.callTool({ name: 'open_workbench', arguments: {} });
    assert.equal(openRes.structuredContent?.ok, false);
    assert.equal(openRes.structuredContent?.mode, 'global');
    assert.match(openRes.structuredContent?.rootError || '', /PLUGIN_DATA/);

    const addRes = await client.callTool({
      name: 'workbench_add_trusted_workspace',
      arguments: { workspacePath: tmpBase },
    });
    assert.equal(addRes.structuredContent?.ok, false);
  } finally {
    await client.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('workspace-bound server rejects workbench_add_trusted_workspace and workbench_remove_trusted_workspace', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ws-reject-global-tools-'));
  const sandboxProject = createSandboxProject(tmpBase, 'demo-ws-only');
  const installed = installWorkspacePlugin(sandboxProject, { distPluginDir });
  const mcpConfig = JSON.parse(
    fs.readFileSync(path.join(installed.installDir, 'mcp_config.json'), 'utf8')
  );
  const resolvedArgs = mcpConfig.mcpServers.workbench_runner.args.map((arg) =>
    arg.replace('${PLUGIN_ROOT}', installed.installDir)
  );

  const client = await connectStdioServer(resolvedArgs);
  try {
    const addRes = await client.callTool({
      name: 'workbench_add_trusted_workspace',
      arguments: { workspacePath: sandboxProject },
    });
    assert.equal(addRes.structuredContent?.ok, false);
    assert.equal(addRes.structuredContent?.mode, 'workspace');

    const removeRes = await client.callTool({
      name: 'workbench_remove_trusted_workspace',
      arguments: { workspaceId: '0123456789ab' },
    });
    assert.equal(removeRes.structuredContent?.ok, false);
    assert.equal(removeRes.structuredContent?.mode, 'workspace');
  } finally {
    await client.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('isUiCapableClient requires io.modelcontextprotocol/ui extension with text/html;profile=mcp-app mimeType', () => {
  assert.equal(isUiCapableClient(null), false);
  assert.equal(isUiCapableClient(undefined), false);
  assert.equal(isUiCapableClient({}), false);
  assert.equal(isUiCapableClient({ extensions: {} }), false);
  assert.equal(
    isUiCapableClient({ extensions: { 'io.modelcontextprotocol/ui': {} } }),
    false
  );
  assert.equal(
    isUiCapableClient({
      extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/plain'] } },
    }),
    false
  );
  assert.equal(
    isUiCapableClient({
      extensions: {
        'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
      },
    }),
    true
  );
  assert.equal(
    isUiCapableClient({
      extensions: {
        'io.modelcontextprotocol/ui': {
          mimeTypes: ['text/plain', 'text/html;profile=mcp-app'],
        },
      },
    }),
    true
  );
});

test('Global Mode server blocks mutating and command-executing tools for non-UI / CLI clients without side effects', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cli-global-gate-'));
  const fakeGlobalInstall = path.join(tmpBase, '.gemini', 'config', 'plugins', 'workbench');
  const pluginDataDir = path.join(tmpBase, '.gemini', 'config', 'plugin-data', 'workbench');
  fs.mkdirSync(path.dirname(fakeGlobalInstall), { recursive: true });
  fs.cpSync(distPluginDir, fakeGlobalInstall, { recursive: true });

  const tempProj = path.join(tmpBase, 'marker-proj');
  const markerPath = path.join(tempProj, 'executed.marker');
  fs.mkdirSync(path.join(tempProj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tempProj, 'src', 'index.mjs'), 'export const ok = true;\n', 'utf8');
  fs.writeFileSync(
    path.join(tempProj, 'workbench.json'),
    JSON.stringify(
      {
        checks: [
          {
            id: 'marker-check',
            name: 'Write side-effect marker if ever executed',
            command: [
              'node',
              '-e',
              `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'EXECUTED')`,
            ],
            files: ['src/index.mjs'],
            timeoutMs: 10000,
          },
        ],
      },
      null,
      2
    ),
    'utf8'
  );

  const mcpConfig = JSON.parse(
    fs.readFileSync(path.join(fakeGlobalInstall, 'mcp_config.json'), 'utf8')
  );
  const resolvedArgs = mcpConfig.mcpServers.workbench_runner.args.map((arg) =>
    arg
      .replace('${PLUGIN_ROOT}', fakeGlobalInstall)
      .replace('${PLUGIN_DATA}', pluginDataDir)
  );

  const client = await connectStdioServer(
    resolvedArgs,
    { PLUGIN_DATA: undefined },
    { uiCapable: false }
  );
  try {
    const trustedFile = getTrustedWorkspacesFilePath(pluginDataDir);

    // 1. Read-only diagnostics report uiHostCapable: false
    const pingRes = await client.callTool({ name: 'workbench_ping', arguments: {} });
    assert.equal(pingRes.isError, undefined);
    assert.equal(pingRes.structuredContent?.ok, true);
    assert.equal(pingRes.structuredContent?.mode, 'global');
    assert.equal(pingRes.structuredContent?.uiHostCapable, false);

    // Read-only open_workbench remains callable
    const openRes = await client.callTool({ name: 'open_workbench', arguments: {} });
    assert.equal(openRes.isError, undefined);
    assert.equal(openRes.structuredContent?.ok, true);

    // 2. workbench_add_trusted_workspace is blocked BEFORE touching disk
    const addRes = await client.callTool({
      name: 'workbench_add_trusted_workspace',
      arguments: { workspacePath: tempProj },
    });
    assert.equal(addRes.isError, true);
    assert.equal(addRes.content?.[0]?.text, UI_HOST_REQUIRED_ERROR);
    assert.equal(addRes.structuredContent?.ok, false);
    assert.equal(addRes.structuredContent?.blockedByUiHostGate, true);
    assert.equal(addRes.structuredContent?.mode, 'global');
    assert.equal(addRes.structuredContent?.error, UI_HOST_REQUIRED_ERROR);
    assert.equal(fs.existsSync(trustedFile), false, 'trusted-workspaces.json must not be created');

    // 3. Pre-seed trusted-workspaces.json and snapshot SHA-256
    const { workspace } = addTrustedWorkspace(pluginDataDir, tempProj);
    const workspaceId = workspace.id;
    const shaBefore = crypto
      .createHash('sha256')
      .update(fs.readFileSync(trustedFile))
      .digest('hex');

    // Read-only workbench_get_status remains callable
    const statusRes = await client.callTool({
      name: 'workbench_get_status',
      arguments: { workspaceId },
    });
    assert.equal(statusRes.isError, undefined);
    assert.equal(statusRes.structuredContent?.ok, true);
    assert.equal(statusRes.structuredContent?.workspaceBound, true);

    // 4. workbench_remove_trusted_workspace is blocked and leaves trusted-workspaces.json untouched
    const removeRes = await client.callTool({
      name: 'workbench_remove_trusted_workspace',
      arguments: { workspaceId },
    });
    assert.equal(removeRes.isError, true);
    assert.equal(removeRes.structuredContent?.ok, false);
    assert.equal(removeRes.structuredContent?.blockedByUiHostGate, true);
    assert.equal(removeRes.structuredContent?.mode, 'global');
    const shaAfter = crypto
      .createHash('sha256')
      .update(fs.readFileSync(trustedFile))
      .digest('hex');
    assert.equal(shaAfter, shaBefore, 'trusted-workspaces.json SHA-256 must remain unchanged');

    // 5. workbench_run_check is blocked before spawning any subprocess or persisting results
    const runCheckRes = await client.callTool({
      name: 'workbench_run_check',
      arguments: { id: 'marker-check', workspaceId },
    });
    assert.equal(runCheckRes.isError, true);
    assert.equal(runCheckRes.structuredContent?.ok, false);
    assert.equal(runCheckRes.structuredContent?.blockedByUiHostGate, true);
    assert.equal(runCheckRes.structuredContent?.mode, 'global');
    assert.equal(fs.existsSync(markerPath), false, 'executed.marker must not exist after blocked run_check');
    assert.equal(
      fs.existsSync(path.join(tempProj, '.workbench', 'results.json')),
      false,
      '.workbench/results.json must not exist after blocked run_check'
    );

    // 6. workbench_run_all is blocked before spawning any subprocess or persisting results
    const runAllRes = await client.callTool({
      name: 'workbench_run_all',
      arguments: { workspaceId },
    });
    assert.equal(runAllRes.isError, true);
    assert.equal(runAllRes.structuredContent?.ok, false);
    assert.equal(runAllRes.structuredContent?.blockedByUiHostGate, true);
    assert.equal(runAllRes.structuredContent?.mode, 'global');
    assert.equal(fs.existsSync(markerPath), false, 'executed.marker must not exist after blocked run_all');
    assert.equal(
      fs.existsSync(path.join(tempProj, '.workbench', 'results.json')),
      false,
      '.workbench/results.json must not exist after blocked run_all'
    );
  } finally {
    await client.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('Workspace Mode server blocks command-executing and mutating tools for non-UI / CLI clients without side effects', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cli-ws-gate-'));
  const sandboxProject = createSandboxProject(tmpBase, 'demo-cli-ws');
  const installed = installWorkspacePlugin(sandboxProject, { distPluginDir });
  const mcpConfig = JSON.parse(
    fs.readFileSync(path.join(installed.installDir, 'mcp_config.json'), 'utf8')
  );
  const resolvedArgs = mcpConfig.mcpServers.workbench_runner.args.map((arg) =>
    arg.replace('${PLUGIN_ROOT}', installed.installDir)
  );

  const client = await connectStdioServer(resolvedArgs, null, { uiCapable: false });
  try {
    const pingRes = await client.callTool({ name: 'workbench_ping', arguments: {} });
    assert.equal(pingRes.isError, undefined);
    assert.equal(pingRes.structuredContent?.ok, true);
    assert.equal(pingRes.structuredContent?.mode, 'workspace');
    assert.equal(pingRes.structuredContent?.uiHostCapable, false);

    // Read-only tools remain callable
    const openRes = await client.callTool({ name: 'open_workbench', arguments: {} });
    assert.equal(openRes.isError, undefined);
    assert.equal(openRes.structuredContent?.ok, true);

    const statusRes = await client.callTool({ name: 'workbench_get_status', arguments: {} });
    assert.equal(statusRes.isError, undefined);
    assert.equal(statusRes.structuredContent?.ok, true);

    // Command-executing tools are blocked before spawning or creating .workbench/results.json
    const runCheckRes = await client.callTool({
      name: 'workbench_run_check',
      arguments: { id: 'format-total' },
    });
    assert.equal(runCheckRes.isError, true);
    assert.equal(runCheckRes.content?.[0]?.text, UI_HOST_REQUIRED_ERROR);
    assert.equal(runCheckRes.structuredContent?.ok, false);
    assert.equal(runCheckRes.structuredContent?.blockedByUiHostGate, true);
    assert.equal(runCheckRes.structuredContent?.mode, 'workspace');
    assert.equal(runCheckRes.structuredContent?.error, UI_HOST_REQUIRED_ERROR);
    assert.equal(
      fs.existsSync(path.join(sandboxProject, '.workbench', 'results.json')),
      false,
      '.workbench/results.json must not exist after blocked workspace run_check'
    );

    const runAllRes = await client.callTool({ name: 'workbench_run_all', arguments: {} });
    assert.equal(runAllRes.isError, true);
    assert.equal(runAllRes.structuredContent?.ok, false);
    assert.equal(runAllRes.structuredContent?.blockedByUiHostGate, true);
    assert.equal(runAllRes.structuredContent?.mode, 'workspace');
    assert.equal(
      fs.existsSync(path.join(sandboxProject, '.workbench', 'results.json')),
      false,
      '.workbench/results.json must not exist after blocked workspace run_all'
    );

    // Mutating workspace-trust tools are also blocked by UI host gate first
    const addRes = await client.callTool({
      name: 'workbench_add_trusted_workspace',
      arguments: { workspacePath: sandboxProject },
    });
    assert.equal(addRes.isError, true);
    assert.equal(addRes.structuredContent?.blockedByUiHostGate, true);

    const removeRes = await client.callTool({
      name: 'workbench_remove_trusted_workspace',
      arguments: { workspaceId: '0123456789ab' },
    });
    assert.equal(removeRes.isError, true);
    assert.equal(removeRes.structuredContent?.blockedByUiHostGate, true);
  } finally {
    await client.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
