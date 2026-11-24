import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCheckRunner } from '../src/check.mjs';
import { readLastRun } from '../src/results.mjs';

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

function createTempProject({ formatTotalCode = GOOD_FORMAT_TOTAL, testCode = FORMAT_TOTAL_TEST } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-check-test-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'format-total.mjs'), formatTotalCode, 'utf8');
  fs.writeFileSync(path.join(dir, 'test', 'format-total.test.mjs'), testCode, 'utf8');
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

test('1. initial state with no persisted record returns not_run', () => {
  const projectRoot = createTempProject();
  try {
    const runner = createCheckRunner({ projectRoot });
    const status = runner.getStatus();

    assert.equal(status.effectiveState, 'not_run');
    assert.equal(status.isValid, false);
    assert.equal(status.isRunning, false);
    assert.equal(status.lastRun, null);
    assert.deepEqual(status.changedFiles, []);
    assert.equal(status.projectRoot, projectRoot);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('2. exit code 0 returns passed with timing, cwd, and output', async () => {
  const projectRoot = createTempProject();
  try {
    const runner = createCheckRunner({ projectRoot });
    const result = await runner.runCheck();

    assert.equal(result.busy, false);
    assert.equal(result.effectiveState, 'passed');
    assert.equal(result.isValid, true);
    assert.equal(result.lastRun.status, 'passed');
    assert.equal(result.lastRun.exitCode, 0);
    assert.equal(result.lastRun.projectRoot, projectRoot);
    assert.equal(result.lastRun.changedBetweenBeforeAndAfter, false);
    assert.ok(result.lastRun.durationMs >= 0);
    assert.match(result.lastRun.output, /1250 分显示为 ¥12\.50/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('3. assertion failure returns failed with non-zero exit code and summary', async () => {
  const projectRoot = createTempProject({ formatTotalCode: BAD_FORMAT_TOTAL });
  try {
    const runner = createCheckRunner({ projectRoot });
    const result = await runner.runCheck();

    assert.equal(result.busy, false);
    assert.equal(result.effectiveState, 'failed');
    assert.equal(result.isValid, true);
    assert.equal(result.lastRun.status, 'failed');
    assert.notEqual(result.lastRun.exitCode, 0);
    assert.match(result.lastRun.output, /1250\.00/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('4. file edit after run marks stale with changedFiles, and reverting restores passed', async () => {
  const projectRoot = createTempProject();
  try {
    const runner = createCheckRunner({ projectRoot });
    await runner.runCheck();

    const srcFile = path.join(projectRoot, 'src', 'format-total.mjs');
    fs.writeFileSync(srcFile, `// comment edit\n${GOOD_FORMAT_TOTAL}`, 'utf8');

    const staleStatus = runner.getStatus();
    assert.equal(staleStatus.effectiveState, 'stale');
    assert.equal(staleStatus.isValid, false);
    assert.equal(staleStatus.lastRun.status, 'passed');
    assert.equal(staleStatus.staleReason, 'files_changed_after_run');
    assert.deepEqual(staleStatus.changedFiles, ['src/format-total.mjs']);

    // Revert to identical content -> fingerprint matches again
    fs.writeFileSync(srcFile, GOOD_FORMAT_TOTAL, 'utf8');
    const restoredStatus = runner.getStatus();
    assert.equal(restoredStatus.effectiveState, 'passed');
    assert.equal(restoredStatus.isValid, true);
    assert.deepEqual(restoredStatus.changedFiles, []);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('5. missing tracked file counts as change and marks stale', async () => {
  const projectRoot = createTempProject();
  try {
    const runner = createCheckRunner({ projectRoot });
    await runner.runCheck();

    fs.rmSync(path.join(projectRoot, 'src', 'format-total.mjs'));

    const status = runner.getStatus();
    assert.equal(status.effectiveState, 'stale');
    assert.equal(status.isValid, false);
    assert.deepEqual(status.changedFiles, ['src/format-total.mjs']);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('6. file changed between before and after run remains stale until re-run', async () => {
  const projectRoot = createTempProject({
    testCode: `import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

test('mutates tracked file during run', () => {
  const target = path.join(process.cwd(), 'src', 'format-total.mjs');
  fs.appendFileSync(target, '\\n// modified during check\\n', 'utf8');
});
`,
  });
  try {
    const runner = createCheckRunner({ projectRoot });
    const result = await runner.runCheck();

    assert.equal(result.lastRun.status, 'passed');
    assert.equal(result.lastRun.changedBetweenBeforeAndAfter, true);
    assert.equal(result.effectiveState, 'stale');
    assert.equal(result.isValid, false);
    assert.equal(result.staleReason, 'changed_between_before_and_after');
    assert.deepEqual(result.changedFiles, ['src/format-total.mjs']);

    // Still stale on subsequent status read (even though current == after)
    const laterStatus = runner.getStatus();
    assert.equal(laterStatus.effectiveState, 'stale');
    assert.equal(laterStatus.staleReason, 'changed_between_before_and_after');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('7. concurrent runCheck calls return busy: true and only spawn once', async () => {
  const projectRoot = createTempProject();
  const markerPath = path.join(projectRoot, 'spawn-count.log');
  try {
    const slowScript = `
      const fs = require('node:fs');
      fs.appendFileSync(${JSON.stringify(markerPath)}, 'run\\n');
      setTimeout(() => process.exit(0), 250);
    `;
    const runner = createCheckRunner({
      projectRoot,
      commandArgs: ['-e', slowScript],
    });

    const p1 = runner.runCheck();
    // Wait a tick so first run has acquired lock
    await new Promise((r) => setTimeout(r, 30));
    const res2 = await runner.runCheck();
    const res1 = await p1;

    assert.equal(res2.busy, true);
    assert.equal(res2.isRunning, true);
    assert.equal(res1.busy, false);
    assert.equal(res1.effectiveState, 'passed');

    const lines = fs.readFileSync(markerPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, 'check process should only have spawned once');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('8a. spawn failure returns error and releases lock', async () => {
  const projectRoot = createTempProject();
  try {
    const runner = createCheckRunner({
      projectRoot,
      execPath: path.join(projectRoot, 'nonexistent-node-binary'),
    });

    const res = await runner.runCheck();
    assert.equal(res.busy, false);
    assert.equal(res.isRunning, false);
    assert.equal(res.effectiveState, 'error');
    assert.equal(res.lastRun.status, 'error');
    assert.match(res.lastRun.output, /ENOENT|启动失败|error/i);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('8b. timeout kills entire process group (including grandchild) and releases lock', async () => {
  const projectRoot = createTempProject();
  const grandchildPidFile = path.join(projectRoot, 'grandchild.pid');
  try {
    const hangWithGrandchildScript = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        env: { ...process.env },
        stdio: 'ignore',
      });
      fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid), 'utf8');
      setInterval(() => {}, 1000);
    `;

    const runner = createCheckRunner({
      projectRoot,
      commandArgs: ['-e', hangWithGrandchildScript],
      timeoutMs: 350,
    });

    const res = await runner.runCheck();
    assert.equal(res.busy, false);
    assert.equal(res.isRunning, false);
    assert.equal(res.effectiveState, 'error');
    assert.equal(res.lastRun.status, 'error');
    assert.equal(res.lastRun.timedOut, true);

    assert.ok(fs.existsSync(grandchildPidFile), 'grandchild pid file should have been written');
    const grandchildPid = Number(fs.readFileSync(grandchildPidFile, 'utf8').trim());
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);

    // Give OS a brief moment to reap the killed process group
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(isPidAlive(grandchildPid), false, `grandchild PID ${grandchildPid} should be terminated`);

    // Lock must be released so a subsequent check can run
    const okRunner = createCheckRunner({ projectRoot });
    const nextRes = await okRunner.runCheck();
    assert.equal(nextRes.effectiveState, 'passed');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('9. atomic persistence leaves no temp files, reloads on new runner, and degrades gracefully on corrupt JSON', async () => {
  const projectRoot = createTempProject();
  try {
    const runner1 = createCheckRunner({ projectRoot });
    await runner1.runCheck();

    const wbDir = path.join(projectRoot, '.workbench');
    const entries = fs.readdirSync(wbDir);
    assert.deepEqual(entries, ['last-run.json']);

    // Simulate reopening pane / new server instance
    const runner2 = createCheckRunner({ projectRoot });
    const reloaded = runner2.getStatus();
    assert.equal(reloaded.effectiveState, 'passed');
    assert.equal(reloaded.lastRun.exitCode, 0);

    // Corrupt last-run.json -> must not crash, reports error state
    fs.writeFileSync(path.join(wbDir, 'last-run.json'), '{not-valid-json', 'utf8');
    const rawRead = readLastRun(projectRoot);
    assert.equal(rawRead.exists, true);
    assert.equal(rawRead.corrupt, true);

    const corruptStatus = runner2.getStatus();
    assert.equal(corruptStatus.effectiveState, 'error');
    assert.ok(corruptStatus.persistenceError);

    // Re-running overwrites corrupt file cleanly
    const recovered = await runner2.runCheck();
    assert.equal(recovered.effectiveState, 'passed');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('10. output exceeding maxOutputBytes is truncated cleanly with UTF-8 safety', async () => {
  const projectRoot = createTempProject();
  try {
    const loudScript = `process.stdout.write('中'.repeat(500));`;
    const runner = createCheckRunner({
      projectRoot,
      commandArgs: ['-e', loudScript],
      maxOutputBytes: 100,
    });

    const res = await runner.runCheck();
    assert.equal(res.effectiveState, 'passed');
    assert.equal(res.lastRun.outputTruncated, true);
    assert.match(res.lastRun.output, /\[输出已截断\]/);
    assert.doesNotMatch(res.lastRun.output, /\uFFFD/, 'truncated UTF-8 must not contain replacement chars');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
