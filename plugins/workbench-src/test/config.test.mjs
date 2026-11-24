import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONFIG_FILE_NAME,
  DEFAULT_TIMEOUT_MS,
  loadWorkspaceConfig,
} from '../src/config.mjs';
import {
  MISSING_FINGERPRINT,
  assertLexicalRelativePathInsideRoot,
  computeFileFingerprints,
  resolveSafeTrackedFilePath,
} from '../src/fingerprint.mjs';

function makeTempWorkspace(prefix = 'wb-config-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeConfig(projectRoot, content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  fs.writeFileSync(path.join(projectRoot, CONFIG_FILE_NAME), text, 'utf8');
}

test('loadWorkspaceConfig parses valid multi-check config, applies default timeoutMs, and computes isolated configFingerprints', () => {
  const root = makeTempWorkspace();
  try {
    writeConfig(root, {
      checks: [
        {
          id: 'format-total',
          name: '  1250 分显示为 ¥12.50  ',
          command: ['node', '--test', 'test/format-total.test.mjs'],
          files: ['src/format-total.mjs', 'test/format-total.test.mjs'],
        },
        {
          id: 'clean_label-2',
          name: '去除标签首尾空格',
          command: ['node', '--test', 'test/clean-label.test.mjs'],
          files: ['src/clean-label.mjs'],
          timeoutMs: 5000,
        },
      ],
    });

    const loaded = loadWorkspaceConfig(root);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.error, null);
    assert.equal(loaded.checks.length, 2);

    const [c1, c2] = loaded.checks;
    assert.equal(c1.id, 'format-total');
    assert.equal(c1.name, '1250 分显示为 ¥12.50');
    assert.equal(c1.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.equal(DEFAULT_TIMEOUT_MS, 15000);
    assert.match(c1.configFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(c2.timeoutMs, 5000);
    assert.notEqual(c1.configFingerprint, c2.configFingerprint);

    // Changing only `name` or another check must NOT change c1's configFingerprint
    writeConfig(root, {
      checks: [
        {
          id: 'format-total',
          name: '新展示名称不影响指纹',
          command: ['node', '--test', 'test/format-total.test.mjs'],
          files: ['src/format-total.mjs', 'test/format-total.test.mjs'],
          timeoutMs: 15000,
        },
        {
          id: 'clean_label-2',
          name: '去除标签首尾空格',
          command: ['node', '--test', 'test/other.test.mjs'],
          files: ['src/clean-label.mjs'],
          timeoutMs: 8000,
        },
      ],
    });
    const reloaded = loadWorkspaceConfig(root);
    assert.equal(reloaded.ok, true);
    assert.equal(reloaded.checks[0].configFingerprint, c1.configFingerprint);
    assert.notEqual(reloaded.checks[1].configFingerprint, c2.configFingerprint);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadWorkspaceConfig rejects missing file, invalid JSON, and invalid schema fields', () => {
  const root = makeTempWorkspace();
  try {
    // Missing workbench.json
    const missing = loadWorkspaceConfig(root);
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.checks, []);
    assert.ok(missing.error);

    // Invalid JSON
    writeConfig(root, '{ bad json');
    const badJson = loadWorkspaceConfig(root);
    assert.equal(badJson.ok, false);
    assert.deepEqual(badJson.checks, []);
    assert.ok(badJson.error);

    const invalidCases = [
      { label: 'empty checks', payload: { checks: [] } },
      { label: 'non-array checks', payload: { checks: {} } },
      {
        label: 'invalid id uppercase',
        payload: {
          checks: [{ id: 'BadId', name: 'x', command: ['node', '-v'], files: ['a.mjs'] }],
        },
      },
      {
        label: 'invalid id starts with dash',
        payload: {
          checks: [{ id: '-bad', name: 'x', command: ['node', '-v'], files: ['a.mjs'] }],
        },
      },
      {
        label: 'duplicate ids',
        payload: {
          checks: [
            { id: 'dup', name: 'a', command: ['node', '-v'], files: ['a.mjs'] },
            { id: 'dup', name: 'b', command: ['node', '-v'], files: ['b.mjs'] },
          ],
        },
      },
      {
        label: 'empty name',
        payload: {
          checks: [{ id: 'a', name: '   ', command: ['node', '-v'], files: ['a.mjs'] }],
        },
      },
      {
        label: 'empty command',
        payload: {
          checks: [{ id: 'a', name: 'a', command: [], files: ['a.mjs'] }],
        },
      },
      {
        label: 'whitespace command[0]',
        payload: {
          checks: [{ id: 'a', name: 'a', command: ['   ', '-v'], files: ['a.mjs'] }],
        },
      },
      {
        label: 'non-string element in command',
        payload: {
          checks: [{ id: 'a', name: 'a', command: ['node', 123], files: ['a.mjs'] }],
        },
      },
      {
        label: 'empty files array',
        payload: {
          checks: [{ id: 'a', name: 'a', command: ['node', '-v'], files: [] }],
        },
      },
      {
        label: 'zero timeoutMs',
        payload: {
          checks: [{ id: 'a', name: 'a', command: ['node', '-v'], files: ['a.mjs'], timeoutMs: 0 }],
        },
      },
      {
        label: 'negative timeoutMs',
        payload: {
          checks: [
            { id: 'a', name: 'a', command: ['node', '-v'], files: ['a.mjs'], timeoutMs: -100 },
          ],
        },
      },
      {
        label: 'float timeoutMs',
        payload: {
          checks: [
            { id: 'a', name: 'a', command: ['node', '-v'], files: ['a.mjs'], timeoutMs: 12.5 },
          ],
        },
      },
      {
        label: 'null timeoutMs',
        payload: {
          checks: [
            { id: 'a', name: 'a', command: ['node', '-v'], files: ['a.mjs'], timeoutMs: null },
          ],
        },
      },
      {
        label: 'absolute file path',
        payload: {
          checks: [{ id: 'a', name: 'a', command: ['node', '-v'], files: ['/etc/passwd'] }],
        },
      },
      {
        label: 'parent escape file path',
        payload: {
          checks: [{ id: 'a', name: 'a', command: ['node', '-v'], files: ['../outside.mjs'] }],
        },
      },
      {
        label: 'dot file path',
        payload: {
          checks: [{ id: 'a', name: 'a', command: ['node', '-v'], files: ['.'] }],
        },
      },
      {
        label: 'NUL byte file path',
        payload: {
          checks: [{ id: 'a', name: 'a', command: ['node', '-v'], files: ['src/a\0b.mjs'] }],
        },
      },
    ];

    for (const tc of invalidCases) {
      writeConfig(root, tc.payload);
      const res = loadWorkspaceConfig(root);
      assert.equal(res.ok, false, `expected invalid case "${tc.label}" to fail`);
      assert.ok(res.error, `expected error message for "${tc.label}"`);
      assert.deepEqual(res.checks, []);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assertLexicalRelativePathInsideRoot enforces segment-based containment', () => {
  const root = '/tmp/proj';
  assert.equal(assertLexicalRelativePathInsideRoot(root, 'src/format-total.mjs'), path.join('src', 'format-total.mjs'));
  assert.throws(() => assertLexicalRelativePathInsideRoot(root, ''));
  assert.throws(() => assertLexicalRelativePathInsideRoot(root, '   '));
  assert.throws(() => assertLexicalRelativePathInsideRoot(root, '.'));
  assert.throws(() => assertLexicalRelativePathInsideRoot(root, './'));
  assert.throws(() => assertLexicalRelativePathInsideRoot(root, '/tmp/proj/src/a.mjs'));
  assert.throws(() => assertLexicalRelativePathInsideRoot(root, '../proj-other/secret.txt'));
  assert.throws(() => assertLexicalRelativePathInsideRoot(root, 'src/../../proj-other/secret.txt'));
  assert.throws(() => assertLexicalRelativePathInsideRoot(root, 'src/a\0b.mjs'));
});

test('resolveSafeTrackedFilePath and computeFileFingerprints guard against symlinks, prefix collisions, dangling symlinks, and loops', () => {
  const base = makeTempWorkspace('wb-symlink-test-');
  try {
    const projectRoot = path.join(base, 'proj');
    const siblingRoot = path.join(base, 'proj-other');
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.mkdirSync(siblingRoot, { recursive: true });

    const internalFile = path.join(projectRoot, 'src', 'real.mjs');
    const outsideFile = path.join(siblingRoot, 'secret.txt');
    fs.writeFileSync(internalFile, 'export const ok = 1;\n', 'utf8');
    fs.writeFileSync(outsideFile, 'SECRET\n', 'utf8');

    // Valid normal existing file
    const normalRes = resolveSafeTrackedFilePath(projectRoot, 'src/real.mjs');
    assert.equal(normalRes.exists, true);
    assert.equal(normalRes.resolvedPath, fs.realpathSync(internalFile));

    // Valid missing file
    const missingRes = resolveSafeTrackedFilePath(projectRoot, 'src/missing.mjs');
    assert.equal(missingRes.exists, false);

    const fp = computeFileFingerprints(projectRoot, ['src/real.mjs', 'src/missing.mjs']);
    assert.match(fp['src/real.mjs'], /^[0-9a-f]{64}$/);
    assert.equal(fp['src/missing.mjs'], MISSING_FINGERPRINT);

    // Valid internal symlink -> allowed
    fs.symlinkSync('./real.mjs', path.join(projectRoot, 'src', 'internal-link.mjs'));
    const internalLinkRes = resolveSafeTrackedFilePath(projectRoot, 'src/internal-link.mjs');
    assert.equal(internalLinkRes.exists, true);
    assert.equal(internalLinkRes.resolvedPath, fs.realpathSync(internalFile));

    // Valid internal dangling symlink -> allowed as MISSING
    fs.symlinkSync('./future-internal.mjs', path.join(projectRoot, 'src', 'internal-dangling.mjs'));
    const internalDanglingRes = resolveSafeTrackedFilePath(projectRoot, 'src/internal-dangling.mjs');
    assert.equal(internalDanglingRes.exists, false);

    // Symlink to prefix-collision sibling directory (/tmp/.../proj-other/secret.txt) -> MUST throw
    fs.symlinkSync(outsideFile, path.join(projectRoot, 'src', 'escape-file.mjs'));
    assert.throws(
      () => resolveSafeTrackedFilePath(projectRoot, 'src/escape-file.mjs'),
      /越出|escape|outside|工作区/i
    );
    assert.throws(() => computeFileFingerprints(projectRoot, ['src/escape-file.mjs']));

    // Directory symlink escaping workspace -> MUST throw even for missing child
    fs.symlinkSync(siblingRoot, path.join(projectRoot, 'src', 'escape-dir'));
    assert.throws(() => resolveSafeTrackedFilePath(projectRoot, 'src/escape-dir/secret.txt'));
    assert.throws(() => resolveSafeTrackedFilePath(projectRoot, 'src/escape-dir/nonexistent.txt'));

    // Dangling symlink pointing directly outside workspace -> MUST throw
    fs.symlinkSync(
      path.join(siblingRoot, 'not-yet-created.txt'),
      path.join(projectRoot, 'src', 'dangling-escape.mjs')
    );
    assert.throws(
      () => resolveSafeTrackedFilePath(projectRoot, 'src/dangling-escape.mjs'),
      /越出|escape|outside|工作区/i
    );

    // Chained dangling symlink (link1 -> link2 -> ../../proj-other/missing.txt) -> MUST throw
    fs.symlinkSync('../../proj-other/chained-missing.txt', path.join(projectRoot, 'src', 'chain-2.mjs'));
    fs.symlinkSync('./chain-2.mjs', path.join(projectRoot, 'src', 'chain-1.mjs'));
    assert.throws(() => resolveSafeTrackedFilePath(projectRoot, 'src/chain-1.mjs'));

    // Symlink loop -> MUST throw
    fs.symlinkSync('./loop-b.mjs', path.join(projectRoot, 'src', 'loop-a.mjs'));
    fs.symlinkSync('./loop-a.mjs', path.join(projectRoot, 'src', 'loop-b.mjs'));
    assert.throws(() => resolveSafeTrackedFilePath(projectRoot, 'src/loop-a.mjs'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
