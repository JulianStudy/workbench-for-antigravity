import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  computeWorkspaceIdentity,
  findConflictingWorkbenchDirs,
  installWorkspacePlugin,
} from '../scripts/install-workspace.mjs';
import { parseServerArgs, resolveRuntimeContext } from '../src/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const installScriptPath = path.join(pkgRoot, 'scripts', 'install-workspace.mjs');

function createFakeDistBundle(baseDir) {
  const distDir = path.join(baseDir, 'dist-workbench');
  fs.mkdirSync(path.join(distDir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(distDir, 'plugin.json'),
    JSON.stringify(
      {
        name: 'workbench',
        displayName: 'Workbench',
        description: 'Local acceptance check sidebar.',
        version: '0.1.0',
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(distDir, 'mcp_config.json'),
    JSON.stringify(
      {
        mcpServers: {
          workbench_runner: {
            command: 'node',
            args: ['${PLUGIN_ROOT}/dist/server.cjs'],
          },
        },
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  fs.writeFileSync(path.join(distDir, 'dist', 'server.cjs'), '// stub server\n', 'utf8');
  fs.writeFileSync(path.join(distDir, 'dist', 'pane.html'), '<html></html>\n', 'utf8');
  return distDir;
}

test('1. installing same workspace twice is idempotent with deterministic identity and valid mcp_config.json', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-install-idempotent-'));
  try {
    const distDir = createFakeDistBundle(tmpBase);
    const workspaceDir = path.join(tmpBase, 'demo-alpha');
    fs.mkdirSync(workspaceDir, { recursive: true });

    // Create a symlink alias to verify realpath normalization produces identical identity
    const symlinkAlias = path.join(tmpBase, 'demo-alpha-link');
    fs.symlinkSync(workspaceDir, symlinkAlias);

    const first = installWorkspacePlugin(workspaceDir, { distPluginDir: distDir });
    const second = installWorkspacePlugin(symlinkAlias, { distPluginDir: distDir });

    const expectedRealRoot = fs.realpathSync(workspaceDir);
    const expectedHash = crypto
      .createHash('sha256')
      .update(expectedRealRoot, 'utf8')
      .digest('hex')
      .slice(0, 12);
    const expectedPluginName = `workbench-${expectedHash}`;
    const expectedTitle = `Workbench (demo-alpha · ${expectedHash.slice(0, 4)})`;

    assert.equal(first.pluginName, expectedPluginName);
    assert.equal(second.pluginName, expectedPluginName);
    assert.equal(first.installDir, second.installDir);
    assert.equal(
      first.installDir,
      path.join(expectedRealRoot, '.agents', 'plugins', expectedPluginName)
    );
    assert.equal(first.displayName, expectedTitle);
    assert.equal(first.entryTitle, expectedTitle);

    const installedPluginJson = JSON.parse(
      fs.readFileSync(path.join(first.installDir, 'plugin.json'), 'utf8')
    );
    assert.equal(installedPluginJson.name, expectedPluginName);
    assert.equal(installedPluginJson.displayName, expectedTitle);
    assert.equal(installedPluginJson.description, 'Local acceptance check sidebar.');
    assert.equal(installedPluginJson.version, '0.1.0');

    const installedMcpConfig = JSON.parse(
      fs.readFileSync(path.join(first.installDir, 'mcp_config.json'), 'utf8')
    );
    assert.equal(installedMcpConfig.mcpServers.workbench_runner.command, 'node');
    assert.deepEqual(installedMcpConfig.mcpServers.workbench_runner.args, [
      '${PLUGIN_ROOT}/dist/server.cjs',
      '--expected-root',
      expectedRealRoot,
      '--entry-title',
      expectedTitle,
    ]);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('2. two distinct workspaces A and B get distinct plugin names and disambiguated displayName / entryTitle', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-install-distinct-'));
  try {
    const distDir = createFakeDistBundle(tmpBase);
    const workspaceA = path.join(tmpBase, 'workspace-a');
    const workspaceB = path.join(tmpBase, 'workspace-b');
    fs.mkdirSync(workspaceA, { recursive: true });
    fs.mkdirSync(workspaceB, { recursive: true });

    const resA = installWorkspacePlugin(workspaceA, { distPluginDir: distDir });
    const resB = installWorkspacePlugin(workspaceB, { distPluginDir: distDir });

    assert.match(resA.pluginName, /^workbench-[0-9a-f]{12}$/);
    assert.match(resB.pluginName, /^workbench-[0-9a-f]{12}$/);
    assert.notEqual(resA.pluginName, resB.pluginName);
    assert.notEqual(resA.displayName, resB.displayName);
    assert.notEqual(resA.entryTitle, resB.entryTitle);
    assert.match(resA.displayName, /^Workbench \(workspace-a · [0-9a-f]{4}\)$/);
    assert.match(resB.displayName, /^Workbench \(workspace-b · [0-9a-f]{4}\)$/);

    // Even two workspaces with the same basename get distinct hash4 tags
    const nestedDir = path.join(tmpBase, 'nested', 'workspace-a');
    fs.mkdirSync(nestedDir, { recursive: true });
    const idA = computeWorkspaceIdentity(workspaceA);
    const idNested = computeWorkspaceIdentity(nestedDir);
    assert.notEqual(idA.pluginName, idNested.pluginName);
    assert.notEqual(idA.entryTitle, idNested.entryTitle);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('3. legacy workbench/ or foreign workbench-<12hex>/ conflict aborts without altering existing files', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-install-conflict-'));
  try {
    const distDir = createFakeDistBundle(tmpBase);
    const workspaceDir = path.join(tmpBase, 'project-with-legacy');
    const pluginsDir = path.join(workspaceDir, '.agents', 'plugins');
    const legacyDir = path.join(pluginsDir, 'workbench');
    const siblingDir = path.join(pluginsDir, 'other-plugin');
    const workbenchDataDir = path.join(workspaceDir, '.workbench');

    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.mkdirSync(workbenchDataDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'sentinel.txt'), 'keep-legacy', 'utf8');
    fs.writeFileSync(path.join(siblingDir, 'keep.txt'), 'keep-sibling', 'utf8');
    fs.writeFileSync(path.join(workbenchDataDir, 'last-run.json'), '{"keep":true}', 'utf8');

    const identity = computeWorkspaceIdentity(workspaceDir);
    const realLegacyPath = path.join(identity.realRoot, '.agents', 'plugins', 'workbench');

    assert.deepEqual(findConflictingWorkbenchDirs(identity.realRoot, identity.pluginName), [
      realLegacyPath,
    ]);

    assert.throws(
      () => installWorkspacePlugin(workspaceDir, { distPluginDir: distDir }),
      (err) => {
        assert.match(err.message, /workbench/);
        assert.ok(err.message.includes(realLegacyPath), 'error should list exact conflicting path');
        return true;
      }
    );

    // Everything pre-existing remains untouched and target dir was not created
    assert.equal(fs.readFileSync(path.join(legacyDir, 'sentinel.txt'), 'utf8'), 'keep-legacy');
    assert.equal(fs.readFileSync(path.join(siblingDir, 'keep.txt'), 'utf8'), 'keep-sibling');
    assert.equal(
      fs.readFileSync(path.join(workbenchDataDir, 'last-run.json'), 'utf8'),
      '{"keep":true}'
    );
    assert.equal(fs.existsSync(identity.installDir), false);

    // Now test foreign workbench-<12hex>/ conflict (e.g. copied from another workspace)
    fs.rmSync(legacyDir, { recursive: true, force: true });
    const foreignName =
      identity.pluginName === 'workbench-000000000000'
        ? 'workbench-111111111111'
        : 'workbench-000000000000';
    const foreignDir = path.join(pluginsDir, foreignName);
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(path.join(foreignDir, 'marker.txt'), 'keep-foreign', 'utf8');

    const realForeignPath = path.join(identity.realRoot, '.agents', 'plugins', foreignName);
    assert.throws(
      () => installWorkspacePlugin(workspaceDir, { distPluginDir: distDir }),
      (err) => {
        assert.ok(err.message.includes(realForeignPath));
        return true;
      }
    );
    assert.equal(fs.readFileSync(path.join(foreignDir, 'marker.txt'), 'utf8'), 'keep-foreign');
    assert.equal(fs.existsSync(identity.installDir), false);

    // Also verify CLI exits non-zero and prints conflicting path to stderr
    const cliRes = spawnSync(process.execPath, [installScriptPath, workspaceDir], {
      cwd: pkgRoot,
      encoding: 'utf8',
    });
    assert.notEqual(cliRes.status, 0);
    assert.ok(cliRes.stderr.includes(realForeignPath));
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('4. copying installed plugin from workspace A into workspace B is rejected by root binding validation', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-binding-mismatch-'));
  try {
    const distDir = createFakeDistBundle(tmpBase);
    const workspaceA = path.join(tmpBase, 'workspace-a');
    const workspaceB = path.join(tmpBase, 'workspace-b');
    fs.mkdirSync(workspaceA, { recursive: true });
    fs.mkdirSync(workspaceB, { recursive: true });

    const installedA = installWorkspacePlugin(workspaceA, { distPluginDir: distDir });
    const copiedIntoB = path.join(workspaceB, '.agents', 'plugins', installedA.pluginName);
    fs.mkdirSync(path.dirname(copiedIntoB), { recursive: true });
    fs.cpSync(installedA.installDir, copiedIntoB, { recursive: true });

    const mcpConfig = JSON.parse(fs.readFileSync(path.join(copiedIntoB, 'mcp_config.json'), 'utf8'));
    const parsed = parseServerArgs(mcpConfig.mcpServers.workbench_runner.args.slice(1));
    assert.equal(parsed.expectedRoot, installedA.realRoot);
    assert.equal(parsed.entryTitle, installedA.entryTitle);

    const ctx = resolveRuntimeContext(copiedIntoB, { expectedRoot: parsed.expectedRoot });
    assert.equal(ctx.ok, false);
    assert.equal(ctx.projectRoot, null);
    assert.ok(ctx.rootError);
    assert.ok(ctx.rootError.includes(installedA.realRoot));
    assert.ok(ctx.rootError.includes(fs.realpathSync(workspaceB)));

    // Non-existent expectedRoot also fails cleanly as mismatch
    const missingCtx = resolveRuntimeContext(installedA.installDir, {
      expectedRoot: path.join(tmpBase, 'deleted-workspace'),
    });
    assert.equal(missingCtx.ok, false);
    assert.equal(missingCtx.projectRoot, null);
    assert.ok(missingCtx.rootError);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('5. unbound server (missing --expected-root) returns ok: false and parseServerArgs handles both flag styles', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-binding-unbound-'));
  try {
    const workspaceDir = path.join(tmpBase, 'unbound-project');
    const pluginDir = path.join(workspaceDir, '.agents', 'plugins', 'workbench');
    fs.mkdirSync(pluginDir, { recursive: true });

    const unboundCtx = resolveRuntimeContext(pluginDir);
    assert.equal(unboundCtx.ok, false);
    assert.equal(unboundCtx.projectRoot, null);
    assert.match(unboundCtx.rootError, /--expected-root/);
    assert.match(unboundCtx.rootError, /install-workspace\.mjs/);

    const emptyCtx = resolveRuntimeContext(pluginDir, { expectedRoot: '   ' });
    assert.equal(emptyCtx.ok, false);
    assert.equal(emptyCtx.projectRoot, null);

    // Valid bound context succeeds
    const validCtx = resolveRuntimeContext(pluginDir, { expectedRoot: workspaceDir });
    assert.equal(validCtx.ok, true);
    assert.equal(validCtx.projectRoot, fs.realpathSync(workspaceDir));
    assert.equal(validCtx.rootError, null);

    // Argument parser tests
    assert.deepEqual(parseServerArgs([]), { expectedRoot: null, entryTitle: 'Workbench' });
    assert.deepEqual(
      parseServerArgs(['--expected-root', '/tmp/foo', '--entry-title', 'Workbench (foo · 1234)']),
      { expectedRoot: '/tmp/foo', entryTitle: 'Workbench (foo · 1234)' }
    );
    assert.deepEqual(
      parseServerArgs(['--expected-root=/tmp/bar', '--entry-title=Workbench (bar · abcd)']),
      { expectedRoot: '/tmp/bar', entryTitle: 'Workbench (bar · abcd)' }
    );
    assert.deepEqual(parseServerArgs(['--expected-root=', '--entry-title=']), {
      expectedRoot: null,
      entryTitle: 'Workbench',
    });
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
