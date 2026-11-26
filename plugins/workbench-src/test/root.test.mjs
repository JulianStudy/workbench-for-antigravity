import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveProjectRootFromPluginDir,
  isInstalledUnderWorkspacePluginsDir,
} from '../src/root.mjs';

test('resolves project root from valid .agents/plugins/<dir> path', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-root-valid-'));
  try {
    const projectRoot = path.join(tmpBase, 'demo-project');
    const pluginDir = path.join(projectRoot, '.agents', 'plugins', 'workbench');
    fs.mkdirSync(pluginDir, { recursive: true });

    const resolved = resolveProjectRootFromPluginDir(pluginDir);
    assert.equal(resolved, fs.realpathSync(projectRoot));
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('rejects plugin installed outside .agents/plugins/<dir> (e.g. global config)', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-root-invalid-'));
  try {
    const fakeGlobalPluginDir = path.join(tmpBase, '.gemini', 'config', 'plugins', 'workbench');
    fs.mkdirSync(fakeGlobalPluginDir, { recursive: true });

    assert.throws(
      () => resolveProjectRootFromPluginDir(fakeGlobalPluginDir),
      /\.agents\/plugins/
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('isInstalledUnderWorkspacePluginsDir distinguishes workspace-scoped vs global installs', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-root-mode-'));
  try {
    const projectRoot = path.join(tmpBase, 'demo-project');
    const wsPluginDir = path.join(projectRoot, '.agents', 'plugins', 'workbench-0123456789ab');
    const globalPluginDir = path.join(tmpBase, '.gemini', 'config', 'plugins', 'workbench');
    const symlinkToWs = path.join(tmpBase, 'link-to-ws');
    fs.mkdirSync(wsPluginDir, { recursive: true });
    fs.mkdirSync(globalPluginDir, { recursive: true });
    fs.symlinkSync(wsPluginDir, symlinkToWs);

    assert.equal(isInstalledUnderWorkspacePluginsDir(wsPluginDir), true);
    assert.equal(isInstalledUnderWorkspacePluginsDir(symlinkToWs), true);
    assert.equal(isInstalledUnderWorkspacePluginsDir(globalPluginDir), false);
    assert.equal(isInstalledUnderWorkspacePluginsDir(path.join(tmpBase, 'nonexistent')), false);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
