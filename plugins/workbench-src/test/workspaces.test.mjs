import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeWorkspaceId,
  readTrustedWorkspaces,
  addTrustedWorkspace,
  removeTrustedWorkspace,
  findTrustedWorkspace,
  enrichWorkspaceList,
  getTrustedWorkspacesFilePath,
} from '../src/workspaces.mjs';

test('computeWorkspaceId returns first 12 lowercase hex chars of sha256(realRoot)', () => {
  const sample = '/tmp/example/workbench-repo';
  const expected = crypto.createHash('sha256').update(sample, 'utf8').digest('hex').slice(0, 12);
  const actual = computeWorkspaceId(sample);
  assert.equal(actual, expected);
  assert.match(actual, /^[0-9a-f]{12}$/);
});

test('readTrustedWorkspaces returns clean empty state when file does not exist', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ws-missing-'));
  try {
    const res = readTrustedWorkspaces(tmpBase);
    assert.deepEqual(res, {
      exists: false,
      corrupt: false,
      workspaces: [],
      error: null,
    });
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('addTrustedWorkspace resolves realpath, writes atomically, is idempotent, and supports find/remove', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ws-crud-'));
  try {
    const dataDir = path.join(tmpBase, 'plugin-data');
    const wsA = path.join(tmpBase, 'project-alpha');
    const wsB = path.join(tmpBase, 'project-beta');
    const wsALink = path.join(tmpBase, 'project-alpha-link');
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });
    fs.symlinkSync(wsA, wsALink);

    const realA = fs.realpathSync(wsA);
    const realB = fs.realpathSync(wsB);

    const addedA = addTrustedWorkspace(dataDir, `  ${wsA}  `);
    assert.equal(addedA.workspace.id, computeWorkspaceId(realA));
    assert.equal(addedA.workspace.path, realA);
    assert.equal(addedA.workspace.label, 'project-alpha');
    assert.ok(Date.parse(addedA.workspace.addedAt) > 0);
    assert.equal(addedA.workspaces.length, 1);

    // Idempotent when adding via symlink alias
    const addedAAgain = addTrustedWorkspace(dataDir, wsALink);
    assert.equal(addedAAgain.workspace.id, addedA.workspace.id);
    assert.equal(addedAAgain.workspace.addedAt, addedA.workspace.addedAt);
    assert.equal(addedAAgain.workspaces.length, 1);

    // Add second workspace
    const addedB = addTrustedWorkspace(dataDir, wsB);
    assert.equal(addedB.workspace.id, computeWorkspaceId(realB));
    assert.equal(addedB.workspaces.length, 2);

    // Check file format and no leftover tmp files
    const entries = fs.readdirSync(dataDir);
    assert.deepEqual(entries, ['trusted-workspaces.json']);
    const raw = JSON.parse(fs.readFileSync(getTrustedWorkspacesFilePath(dataDir), 'utf8'));
    assert.equal(raw.schemaVersion, 1);
    assert.equal(raw.workspaces.length, 2);

    // findTrustedWorkspace
    assert.deepEqual(findTrustedWorkspace(dataDir, addedA.workspace.id), addedA.workspace);
    assert.equal(findTrustedWorkspace(dataDir, '000000000000'), null);

    // removeTrustedWorkspace
    const missingRemove = removeTrustedWorkspace(dataDir, '000000000000');
    assert.equal(missingRemove.removed, false);
    assert.equal(missingRemove.workspaces.length, 2);

    const removedA = removeTrustedWorkspace(dataDir, addedA.workspace.id);
    assert.equal(removedA.removed, true);
    assert.deepEqual(
      removedA.workspaces.map((w) => w.id),
      [addedB.workspace.id]
    );
    assert.equal(findTrustedWorkspace(dataDir, addedA.workspace.id), null);
    assert.deepEqual(fs.readdirSync(dataDir), ['trusted-workspaces.json']);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('addTrustedWorkspace rejects invalid paths, files, NUL bytes, and filesystem root', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ws-validate-'));
  try {
    const dataDir = path.join(tmpBase, 'plugin-data');
    const regularFile = path.join(tmpBase, 'file.txt');
    fs.writeFileSync(regularFile, 'hi', 'utf8');

    assert.throws(() => addTrustedWorkspace(dataDir, ''), /路径|目录|empty|required/i);
    assert.throws(() => addTrustedWorkspace(dataDir, '   '), /路径|目录|empty|required/i);
    assert.throws(() => addTrustedWorkspace(dataDir, null), /路径|目录|string/i);
    assert.throws(() => addTrustedWorkspace(dataDir, '/tmp/bad\0path'), /NUL|非法|空字符/i);
    assert.throws(
      () => addTrustedWorkspace(dataDir, path.join(tmpBase, 'does-not-exist')),
      /不存在|无法访问|ENOENT/i
    );
    assert.throws(() => addTrustedWorkspace(dataDir, regularFile), /目录|directory/i);

    const fsRoot = path.parse(tmpBase).root;
    assert.throws(() => addTrustedWorkspace(dataDir, fsRoot), /根目录|root/i);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('readTrustedWorkspaces reports corrupt JSON and invalid schema cleanly, and deduplicates valid entries', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ws-corrupt-'));
  try {
    const dataDir = path.join(tmpBase, 'plugin-data');
    fs.mkdirSync(dataDir, { recursive: true });
    const filePath = getTrustedWorkspacesFilePath(dataDir);

    // Corrupt JSON
    fs.writeFileSync(filePath, '{bad json', 'utf8');
    const badJson = readTrustedWorkspaces(dataDir);
    assert.equal(badJson.exists, true);
    assert.equal(badJson.corrupt, true);
    assert.deepEqual(badJson.workspaces, []);
    assert.ok(badJson.error);

    // Wrong schemaVersion
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 99, workspaces: [] }), 'utf8');
    const badSchema = readTrustedWorkspaces(dataDir);
    assert.equal(badSchema.exists, true);
    assert.equal(badSchema.corrupt, true);
    assert.ok(badSchema.error);

    // Invalid entry inside workspaces
    fs.writeFileSync(
      filePath,
      JSON.stringify({ schemaVersion: 1, workspaces: [{ id: 'bad', path: '' }] }),
      'utf8'
    );
    const badEntry = readTrustedWorkspaces(dataDir);
    assert.equal(badEntry.exists, true);
    assert.equal(badEntry.corrupt, true);
    assert.ok(badEntry.error);

    // Valid with duplicate id -> deduplicated preserving first
    const wsPath = '/tmp/dedup-demo';
    const id = computeWorkspaceId(wsPath);
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        workspaces: [
          { id, path: wsPath, label: 'first', addedAt: '2026-01-01T00:00:00.000Z' },
          { id, path: wsPath, label: 'second', addedAt: '2026-01-02T00:00:00.000Z' },
        ],
      }),
      'utf8'
    );
    const deduped = readTrustedWorkspaces(dataDir);
    assert.equal(deduped.exists, true);
    assert.equal(deduped.corrupt, false);
    assert.equal(deduped.error, null);
    assert.equal(deduped.workspaces.length, 1);
    assert.equal(deduped.workspaces[0].label, 'first');
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('enrichWorkspaceList safely checks directory and workbench.json existence', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ws-enrich-'));
  try {
    const withCfg = path.join(tmpBase, 'with-cfg');
    const withoutCfg = path.join(tmpBase, 'without-cfg');
    const deleted = path.join(tmpBase, 'deleted');
    fs.mkdirSync(withCfg, { recursive: true });
    fs.mkdirSync(withoutCfg, { recursive: true });
    fs.writeFileSync(path.join(withCfg, 'workbench.json'), '{"checks":[]}', 'utf8');

    const enriched = enrichWorkspaceList([
      {
        id: computeWorkspaceId(withCfg),
        path: withCfg,
        label: 'with-cfg',
        addedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: computeWorkspaceId(withoutCfg),
        path: withoutCfg,
        label: 'without-cfg',
        addedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: computeWorkspaceId(deleted),
        path: deleted,
        label: 'deleted',
        addedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    assert.deepEqual(
      enriched.map((w) => [w.label, w.exists, w.hasConfig]),
      [
        ['with-cfg', true, true],
        ['without-cfg', true, false],
        ['deleted', false, false],
      ]
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('atomic write cleans up temporary file on rename error', (t) => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ws-atomic-'));
  try {
    const dataDir = path.join(tmpBase, 'plugin-data');
    const ws = path.join(tmpBase, 'my-proj');
    fs.mkdirSync(ws, { recursive: true });

    t.mock.method(fs, 'renameSync', () => {
      throw new Error('simulated rename failure');
    });

    assert.throws(() => addTrustedWorkspace(dataDir, ws), /simulated rename failure/);
    assert.deepEqual(fs.readdirSync(dataDir), []);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
