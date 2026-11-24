import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbenchRunner, truncateUtf8Bytes } from '../src/check.mjs';
import { readResults, SCHEMA_VERSION } from '../src/results.mjs';

const GOOD_FORMAT_TOTAL = `export function formatTotal(cents) {
  const yuan = Math.floor(cents / 100);
  const fen = String(cents % 100).padStart(2, '0');
  return \`¥\${yuan}.\${fen}\`;
}
`;

const BAD_FORMAT_TOTAL = `export function formatTotal(cents) {
  return \`¥\${cents}.00\`;
}
`;

const FORMAT_TOTAL_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTotal } from '../src/format-total.mjs';

test('1250 分显示为 ¥12.50', () => {
  assert.equal(formatTotal(1250), '¥12.50');
});
`;

const GOOD_CLEAN_LABEL = `export function cleanLabel(value) {
  return value.trim();
}
`;

const CLEAN_LABEL_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanLabel } from '../src/clean-label.mjs';

test('去除标签首尾空格', () => {
  assert.equal(cleanLabel('  demo  '), 'demo');
});
`;

const DEFAULT_CHECKS = [
  {
    id: 'format-total',
    name: '1250 分显示为 ¥12.50',
    command: ['node', '--test', '--test-isolation=none', 'test/format-total.test.mjs'],
    files: ['src/format-total.mjs', 'test/format-total.test.mjs'],
    timeoutMs: 15000,
  },
  {
    id: 'clean-label',
    name: '去除标签首尾空格',
    command: ['node', '--test', '--test-isolation=none', 'test/clean-label.test.mjs'],
    files: ['src/clean-label.mjs', 'test/clean-label.test.mjs'],
    timeoutMs: 15000,
  },
];

function createTempProject({
  formatTotalCode = GOOD_FORMAT_TOTAL,
  formatTotalTestCode = FORMAT_TOTAL_TEST,
  cleanLabelCode = GOOD_CLEAN_LABEL,
  cleanLabelTestCode = CLEAN_LABEL_TEST,
  checks = DEFAULT_CHECKS,
  writeConfigFile = true,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-check-test-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'format-total.mjs'), formatTotalCode, 'utf8');
  fs.writeFileSync(path.join(dir, 'test', 'format-total.test.mjs'), formatTotalTestCode, 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'clean-label.mjs'), cleanLabelCode, 'utf8');
  fs.writeFileSync(path.join(dir, 'test', 'clean-label.test.mjs'), cleanLabelTestCode, 'utf8');
  if (writeConfigFile) {
    fs.writeFileSync(path.join(dir, 'workbench.json'), JSON.stringify({ checks }, null, 2), 'utf8');
  }
  return dir;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('0. truncateUtf8Bytes enforces UTF-8 byte budget without replacement chars', () => {
  const shortRes = truncateUtf8Bytes('hello 世界', 100);
  assert.equal(shortRes.truncated, false);
  assert.equal(shortRes.text, 'hello 世界');

  const big = '中'.repeat(1000);
  const res100 = truncateUtf8Bytes(big, 100);
  assert.equal(res100.truncated, true);
  assert.match(res100.text, /\[输出已截断\]$/);
  assert.doesNotMatch(res100.text, /\uFFFD/);
  assert.ok(Buffer.byteLength(res100.text, 'utf8') <= 100);

  const res2k = truncateUtf8Bytes(big, 2048);
  assert.equal(res2k.truncated, true);
  assert.doesNotMatch(res2k.text, /\uFFFD/);
  assert.ok(Buffer.byteLength(res2k.text, 'utf8') <= 2048);
});

test('1. initial state with multi-check config returns not_run for all checks and missing config degrades cleanly', async () => {
  const projectRoot = createTempProject();
  try {
    const runner = createWorkbenchRunner({ projectRoot });
    const status = runner.getStatus();

    assert.equal(status.ok, true);
    assert.equal(status.configOk, true);
    assert.equal(status.configError, null);
    assert.equal(status.isRunning, false);
    assert.equal(status.runningCheckId, null);
    assert.equal(status.runningBatch, false);
    assert.deepEqual(status.counts, {
      total: 2,
      not_run: 2,
      passed: 0,
      failed: 0,
      stale: 0,
      error: 0,
    });
    assert.deepEqual(
      status.checks.map((c) => [c.id, c.effectiveState, c.lastRun]),
      [
        ['format-total', 'not_run', null],
        ['clean-label', 'not_run', null],
      ]
    );

    // Missing workbench.json -> configOk: false, empty checks, clear error
    fs.rmSync(path.join(projectRoot, 'workbench.json'));
    const badStatus = runner.getStatus();
    assert.equal(badStatus.ok, true);
    assert.equal(badStatus.configOk, false);
    assert.ok(badStatus.configError);
    assert.deepEqual(badStatus.checks, []);
    assert.equal(badStatus.counts.total, 0);

    const runErr = await runner.runCheck('format-total');
    assert.equal(runErr.ok, false);
    assert.equal(runErr.busy, false);
    assert.ok(runErr.error);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('2. single runCheck persists schema v2 results.json, preserves legacy last-run.json, and enforces output payload isolation', async () => {
  const projectRoot = createTempProject();
  try {
    // Seed an alpha.2 last-run.json to prove alpha.3 never touches or deletes it
    const wbDir = path.join(projectRoot, '.workbench');
    fs.mkdirSync(wbDir, { recursive: true });
    const legacyPath = path.join(wbDir, 'last-run.json');
    fs.writeFileSync(legacyPath, '{"schemaVersion":1,"keep":true}\n', 'utf8');

    const runner = createWorkbenchRunner({ projectRoot });
    const res = await runner.runCheck('format-total');

    assert.equal(res.busy, false);
    assert.equal(res.ranCheckId, 'format-total');
    assert.deepEqual(res.counts, {
      total: 2,
      not_run: 1,
      passed: 1,
      failed: 0,
      stale: 0,
      error: 0,
    });

    // Summary checks MUST omit `output` while reporting `hasOutput`
    const summaryC1 = res.checks.find((c) => c.id === 'format-total');
    const summaryC2 = res.checks.find((c) => c.id === 'clean-label');
    assert.equal(summaryC1.effectiveState, 'passed');
    assert.equal(summaryC1.isValid, true);
    assert.equal(summaryC1.lastRun.exitCode, 0);
    assert.equal(summaryC1.lastRun.hasOutput, true);
    assert.equal('output' in summaryC1.lastRun, false, 'summary must omit output');
    assert.equal(summaryC2.effectiveState, 'not_run');

    // Detail call MUST include full `output`
    const detail = runner.getStatus({ id: 'format-total' });
    assert.equal(detail.ok, true);
    assert.equal(detail.check.id, 'format-total');
    assert.match(detail.check.lastRun.output, /1250 分显示为 ¥12\.50/);

    // Unknown id returns clear error
    const missingDetail = runner.getStatus({ id: 'nonexistent' });
    assert.equal(missingDetail.ok, false);
    assert.ok(missingDetail.error);

    // Check persistence schema v2 + no leftover temp files + legacy untouched
    const entries = fs.readdirSync(wbDir).sort();
    assert.deepEqual(entries, ['last-run.json', 'results.json']);
    assert.equal(fs.readFileSync(legacyPath, 'utf8'), '{"schemaVersion":1,"keep":true}\n');

    const raw = readResults(projectRoot);
    assert.equal(raw.exists, true);
    assert.equal(raw.corrupt, false);
    assert.equal(raw.data.schemaVersion, SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 2);
    assert.ok(raw.data.checks['format-total']);
    assert.equal(raw.data.checks['clean-label'], undefined);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('3. file edit and config change isolate staleness to the affected check only', async () => {
  const projectRoot = createTempProject();
  try {
    const runner = createWorkbenchRunner({ projectRoot });
    const allRes = await runner.runAll();
    assert.equal(allRes.busy, false);
    assert.equal(allRes.counts.passed, 2);

    // Edit ONLY format-total's file -> clean-label stays passed!
    const fmtFile = path.join(projectRoot, 'src', 'format-total.mjs');
    fs.writeFileSync(fmtFile, `// edit\n${GOOD_FORMAT_TOTAL}`, 'utf8');

    const staleStatus = runner.getStatus();
    const fmtCheck = staleStatus.checks.find((c) => c.id === 'format-total');
    const lblCheck = staleStatus.checks.find((c) => c.id === 'clean-label');
    assert.equal(fmtCheck.effectiveState, 'stale');
    assert.equal(fmtCheck.staleReason, 'files_changed_after_run');
    assert.deepEqual(fmtCheck.changedFiles, ['src/format-total.mjs']);
    assert.equal(lblCheck.effectiveState, 'passed');
    assert.equal(lblCheck.isValid, true);

    // Revert file -> format-total returns to passed
    fs.writeFileSync(fmtFile, GOOD_FORMAT_TOTAL, 'utf8');
    assert.equal(runner.getStatus().counts.passed, 2);

    // Rename display `name` of format-total -> MUST NOT mark stale
    const renamedChecks = DEFAULT_CHECKS.map((c) =>
      c.id === 'format-total' ? { ...c, name: '金额格式化（重命名）' } : c
    );
    fs.writeFileSync(
      path.join(projectRoot, 'workbench.json'),
      JSON.stringify({ checks: renamedChecks }, null, 2),
      'utf8'
    );
    const afterRename = runner.getStatus();
    assert.equal(afterRename.counts.passed, 2);
    assert.equal(afterRename.checks[0].name, '金额格式化（重命名）');

    // Change timeoutMs of format-total -> ONLY format-total becomes stale with config_changed
    const timeoutChangedChecks = DEFAULT_CHECKS.map((c) =>
      c.id === 'format-total' ? { ...c, timeoutMs: 20000 } : c
    );
    fs.writeFileSync(
      path.join(projectRoot, 'workbench.json'),
      JSON.stringify({ checks: timeoutChangedChecks }, null, 2),
      'utf8'
    );
    const afterConfigChange = runner.getStatus();
    const c1 = afterConfigChange.checks.find((c) => c.id === 'format-total');
    const c2 = afterConfigChange.checks.find((c) => c.id === 'clean-label');
    assert.equal(c1.effectiveState, 'stale');
    assert.equal(c1.staleReason, 'config_changed');
    assert.equal(c2.effectiveState, 'passed');

    // Remove clean-label from workbench.json -> not shown in status.checks
    fs.writeFileSync(
      path.join(projectRoot, 'workbench.json'),
      JSON.stringify({ checks: [timeoutChangedChecks[0]] }, null, 2),
      'utf8'
    );
    const afterRemove = runner.getStatus();
    assert.deepEqual(
      afterRemove.checks.map((c) => c.id),
      ['format-total']
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('4. file changed between before and after run stays stale while retaining exitCode and status', async () => {
  const projectRoot = createTempProject({
    formatTotalTestCode: `import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

test('mutates tracked file during run', () => {
  const target = path.join(process.cwd(), 'src', 'format-total.mjs');
  fs.appendFileSync(target, '\\n// modified during check\\n', 'utf8');
});
`,
  });
  try {
    const runner = createWorkbenchRunner({ projectRoot });
    const res = await runner.runCheck('format-total');
    const c = res.checks.find((x) => x.id === 'format-total');

    assert.equal(c.effectiveState, 'stale');
    assert.equal(c.isValid, false);
    assert.equal(c.staleReason, 'changed_between_before_and_after');
    assert.deepEqual(c.changedFiles, ['src/format-total.mjs']);
    assert.equal(c.lastRun.status, 'passed');
    assert.equal(c.lastRun.exitCode, 0);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('5. symlink escape puts only that check into error state without affecting sibling checks', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sym-check-'));
  try {
    const outsideDir = path.join(base, 'outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'secret', 'utf8');

    const projectRoot = createTempProject();
    fs.rmSync(path.join(projectRoot, 'src', 'format-total.mjs'));
    fs.symlinkSync(outsideFile, path.join(projectRoot, 'src', 'format-total.mjs'));

    const runner = createWorkbenchRunner({ projectRoot });
    const statusBefore = runner.getStatus();
    const badBefore = statusBefore.checks.find((c) => c.id === 'format-total');
    const goodBefore = statusBefore.checks.find((c) => c.id === 'clean-label');
    assert.equal(badBefore.effectiveState, 'error');
    assert.match(badBefore.checkError || '', /越出|工作区|symlink/i);
    assert.equal(goodBefore.effectiveState, 'not_run');

    // runAll runs clean-label and records format-total error cleanly
    const allRes = await runner.runAll();
    const badAfter = allRes.checks.find((c) => c.id === 'format-total');
    const goodAfter = allRes.checks.find((c) => c.id === 'clean-label');
    assert.equal(badAfter.effectiveState, 'error');
    assert.equal(goodAfter.effectiveState, 'passed');

    fs.rmSync(projectRoot, { recursive: true, force: true });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('6. runAll runs sequentially, continues after failed/error checks, and supports non-node PATH commands and missing binaries', async () => {
  const projectRoot = createTempProject({
    formatTotalCode: BAD_FORMAT_TOTAL,
    checks: [
      DEFAULT_CHECKS[0], // will fail
      {
        id: 'missing-bin',
        name: '缺失可执行文件',
        command: ['definitely-not-a-real-workbench-binary-xyz'],
        files: ['src/clean-label.mjs'],
        timeoutMs: 5000,
      },
      {
        id: 'path-cmd',
        name: '非 node PATH 命令',
        command: ['sh', '-c', 'printf hello-from-path'],
        files: ['src/clean-label.mjs'],
        timeoutMs: 5000,
      },
      DEFAULT_CHECKS[1], // will pass
    ],
  });
  try {
    const runner = createWorkbenchRunner({ projectRoot });
    const res = await runner.runAll();

    assert.equal(res.busy, false);
    assert.equal(res.isRunning, false);
    assert.deepEqual(res.counts, {
      total: 4,
      not_run: 0,
      passed: 2,
      failed: 1,
      stale: 0,
      error: 1,
    });
    assert.equal(res.checks.find((c) => c.id === 'format-total').effectiveState, 'failed');
    assert.equal(res.checks.find((c) => c.id === 'missing-bin').effectiveState, 'error');
    assert.equal(res.checks.find((c) => c.id === 'path-cmd').effectiveState, 'passed');
    assert.equal(res.checks.find((c) => c.id === 'clean-label').effectiveState, 'passed');
    const pathDetail = runner.getStatus({ id: 'path-cmd' });
    assert.equal(pathDetail.check.lastRun.output, 'hello-from-path');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('7. mid-batch config change skips modified check without executing it and records exact reason', async () => {
  const projectRoot = createTempProject();
  const check2Marker = path.join(projectRoot, 'check2-ran.txt');
  const check3Marker = path.join(projectRoot, 'check3-ran.txt');
  const configPath = path.join(projectRoot, 'workbench.json');

  const mutateConfigScript = `
    const fs = require('node:fs');
    const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, 'utf8'));
    cfg.checks[1].command = ['node', '-e', 'require("node:fs").writeFileSync(${JSON.stringify(check2Marker)}, "mutated")'];
    fs.writeFileSync(${JSON.stringify(configPath)}, JSON.stringify(cfg, null, 2), 'utf8');
  `;

  const checks = [
    {
      id: 'step-1',
      name: '第一步（修改第二步配置）',
      command: ['node', '-e', mutateConfigScript],
      files: ['src/format-total.mjs'],
      timeoutMs: 10000,
    },
    {
      id: 'step-2',
      name: '第二步（应被跳过）',
      command: [
        'node',
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(check2Marker)}, 'original')`,
      ],
      files: ['src/clean-label.mjs'],
      timeoutMs: 10000,
    },
    {
      id: 'step-3',
      name: '第三步（保持不变应继续执行）',
      command: [
        'node',
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(check3Marker)}, 'ran')`,
      ],
      files: ['src/clean-label.mjs'],
      timeoutMs: 10000,
    },
  ];
  fs.writeFileSync(configPath, JSON.stringify({ checks }, null, 2), 'utf8');

  try {
    const runner = createWorkbenchRunner({ projectRoot });
    const res = await runner.runAll();

    assert.equal(res.busy, false);
    assert.equal(fs.existsSync(check2Marker), false, 'step-2 MUST NOT have executed');
    assert.equal(fs.existsSync(check3Marker), true, 'step-3 MUST have executed');
    assert.deepEqual(res.skippedChecks, [
      {
        id: 'step-2',
        name: '第二步（应被跳过）',
        reason: '运行期间该项配置已变更，已跳过执行，请确认后重新运行',
      },
    ]);
    assert.equal(res.checks.find((c) => c.id === 'step-1').effectiveState, 'passed');
    assert.equal(res.checks.find((c) => c.id === 'step-2').effectiveState, 'not_run');
    assert.equal(res.checks.find((c) => c.id === 'step-3').effectiveState, 'passed');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('8. shared lock prevents concurrent runCheck and runAll from spawning twice', async () => {
  const projectRoot = createTempProject();
  const markerPath = path.join(projectRoot, 'spawn-count.log');
  const slowScript = `
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(markerPath)}, 'run\\n');
    setTimeout(() => process.exit(0), 250);
  `;
  const checks = [
    {
      id: 'slow-check',
      name: '慢速检查',
      command: ['node', '-e', slowScript],
      files: ['src/format-total.mjs'],
      timeoutMs: 10000,
    },
  ];
  fs.writeFileSync(path.join(projectRoot, 'workbench.json'), JSON.stringify({ checks }, null, 2), 'utf8');

  try {
    const runner = createWorkbenchRunner({ projectRoot });
    const p1 = runner.runCheck('slow-check');
    await new Promise((r) => setTimeout(r, 30));

    const busyCheck = await runner.runCheck('slow-check');
    const busyAll = await runner.runAll();
    const res1 = await p1;

    assert.equal(busyCheck.busy, true);
    assert.equal(busyCheck.isRunning, true);
    assert.equal(busyCheck.runningCheckId, 'slow-check');
    assert.equal(busyAll.busy, true);
    assert.equal(res1.busy, false);
    assert.equal(res1.counts.passed, 1);

    const lines = fs.readFileSync(markerPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('9. per-check timeout kills process group including grandchild and releases lock', async () => {
  const projectRoot = createTempProject();
  const grandchildPidFile = path.join(projectRoot, 'grandchild.pid');
  const hangScript = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: { ...process.env },
      stdio: 'ignore',
    });
    fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid), 'utf8');
    setInterval(() => {}, 1000);
  `;
  const checks = [
    {
      id: 'hang-check',
      name: '超时检查',
      command: ['node', '-e', hangScript],
      files: ['src/format-total.mjs'],
      timeoutMs: 350,
    },
    DEFAULT_CHECKS[1],
  ];
  fs.writeFileSync(path.join(projectRoot, 'workbench.json'), JSON.stringify({ checks }, null, 2), 'utf8');

  try {
    const runner = createWorkbenchRunner({ projectRoot });
    const res = await runner.runCheck('hang-check');
    assert.equal(res.busy, false);
    assert.equal(res.isRunning, false);
    const hangCheck = res.checks.find((c) => c.id === 'hang-check');
    assert.equal(hangCheck.effectiveState, 'error');
    assert.equal(hangCheck.lastRun.timedOut, true);

    assert.ok(fs.existsSync(grandchildPidFile));
    const grandchildPid = Number(fs.readFileSync(grandchildPidFile, 'utf8').trim());
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(isPidAlive(grandchildPid), false);

    // Lock released: sibling check can run cleanly
    const nextRes = await runner.runCheck('clean-label');
    assert.equal(nextRes.checks.find((c) => c.id === 'clean-label').effectiveState, 'passed');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('10. corrupt results.json degrades gracefully and recovers on re-run; loud output truncates cleanly', async () => {
  const projectRoot = createTempProject();
  try {
    const checks = [
      {
        id: 'loud',
        name: '长输出检查',
        command: ['node', '-e', "process.stdout.write('中'.repeat(500));"],
        files: ['src/format-total.mjs'],
        timeoutMs: 10000,
      },
      DEFAULT_CHECKS[1],
    ];
    fs.writeFileSync(path.join(projectRoot, 'workbench.json'), JSON.stringify({ checks }, null, 2), 'utf8');

    const runner = createWorkbenchRunner({ projectRoot, maxOutputBytes: 100 });
    const res = await runner.runCheck('loud');
    assert.equal(res.checkDetail.check.lastRun.outputTruncated, true);
    assert.ok(Buffer.byteLength(res.checkDetail.check.lastRun.output, 'utf8') <= 100);
    assert.doesNotMatch(res.checkDetail.check.lastRun.output, /\uFFFD/);

    // Corrupt results.json
    const resultsPath = path.join(projectRoot, '.workbench', 'results.json');
    fs.writeFileSync(resultsPath, '{broken json', 'utf8');

    const raw = readResults(projectRoot);
    assert.equal(raw.exists, true);
    assert.equal(raw.corrupt, true);

    const corruptStatus = runner.getStatus();
    assert.ok(corruptStatus.persistenceError);
    assert.equal(corruptStatus.counts.error, 2);

    // Recover by re-running clean-label
    const recovered = await runner.runCheck('clean-label');
    assert.equal(recovered.persistenceError, null);
    assert.equal(recovered.checks.find((c) => c.id === 'clean-label').effectiveState, 'passed');
    assert.equal(recovered.checks.find((c) => c.id === 'loud').effectiveState, 'not_run');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
