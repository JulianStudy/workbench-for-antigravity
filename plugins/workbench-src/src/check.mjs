import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  computeFileFingerprints,
  DEFAULT_TRACKED_FILES,
  diffFingerprints,
} from './fingerprint.mjs';
import { readLastRun, writeLastRunAtomic } from './results.mjs';

export const ACCEPTANCE_CRITERION = '1250 分显示为 ¥12.50';
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024;
export const DEFAULT_TEST_ARGS = [
  '--test',
  '--test-isolation=none',
  '--test-reporter=spec',
  'test/format-total.test.mjs',
];

function formatDisplayCommand(args) {
  return `node ${args.join(' ')}`;
}

function buildChildEnv() {
  const env = {
    ...process.env,
    NO_COLOR: '1',
    NODE_DISABLE_COLORS: '1',
    FORCE_COLOR: '0',
  };
  delete env.NODE_TEST_CONTEXT;
  if (process.versions?.electron || process.env.ELECTRON_RUN_AS_NODE) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  return env;
}

function decodeUtf8Bounded(chunks, maxBytes) {
  const full = Buffer.concat(chunks);
  if (full.length <= maxBytes) {
    return { text: full.toString('utf8'), truncated: false };
  }
  const decoder = new StringDecoder('utf8');
  const safePrefix = decoder.write(full.subarray(0, maxBytes));
  return {
    text: `${safePrefix}\n...[输出已截断]`,
    truncated: true,
  };
}

function killProcessGroup(pid, signal) {
  if (!pid) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, signal);
    } else {
      process.kill(pid, signal);
    }
  } catch {
    // Process or group already exited
  }
}

function runSubprocess({ execPath, commandArgs, cwd, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const startHr = Date.now();
    const chunks = [];
    let collectedBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    let killGraceTimer = null;

    const child = spawn(execPath, commandArgs, {
      cwd,
      env: buildChildEnv(),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onChunk = (buf) => {
      if (collectedBytes <= maxOutputBytes) {
        const remaining = maxOutputBytes + 1 - collectedBytes;
        chunks.push(buf.length > remaining ? buf.subarray(0, remaining) : buf);
        collectedBytes += buf.length;
      } else {
        outputTruncated = true;
      }
    };

    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    const finalize = ({ exitCode, signal, spawnError }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);

      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startHr;
      const decoded = decodeUtf8Bounded(chunks, maxOutputBytes);
      let output = decoded.text;
      const truncated = decoded.truncated || outputTruncated;

      if (spawnError) {
        const msg = `启动失败: ${spawnError.message || String(spawnError)}`;
        output = output ? `${output}\n${msg}` : msg;
      } else if (timedOut) {
        const msg = `执行超时（超过 ${timeoutMs}ms），已终止检查进程组。`;
        output = output ? `${output}\n${msg}` : msg;
      }

      let status;
      if (spawnError || timedOut || exitCode === null) {
        status = 'error';
      } else if (exitCode === 0) {
        status = 'passed';
      } else {
        status = 'failed';
      }

      resolve({
        startedAt,
        finishedAt,
        durationMs,
        status,
        exitCode: exitCode ?? null,
        signal: signal ?? null,
        timedOut,
        output,
        outputTruncated: truncated,
      });
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid, 'SIGTERM');
      killGraceTimer = setTimeout(() => {
        killProcessGroup(child.pid, 'SIGKILL');
      }, 150);
    }, timeoutMs);

    child.on('error', (err) => {
      finalize({ exitCode: null, signal: null, spawnError: err });
    });

    child.on('close', (code, signal) => {
      finalize({ exitCode: code, signal, spawnError: null });
    });
  });
}

export function createCheckRunner({
  projectRoot,
  trackedFiles = DEFAULT_TRACKED_FILES,
  execPath = process.execPath,
  commandArgs = DEFAULT_TEST_ARGS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
}) {
  let isRunning = false;

  function getStatus() {
    const persisted = readLastRun(projectRoot);
    const base = {
      ok: true,
      projectRoot,
      criterion: ACCEPTANCE_CRITERION,
      command: formatDisplayCommand(commandArgs),
      trackedFiles: [...trackedFiles],
      isRunning,
      persistenceError: null,
      staleReason: null,
      changedFiles: [],
      lastRun: null,
    };

    if (persisted.corrupt) {
      return {
        ...base,
        effectiveState: 'error',
        isValid: false,
        persistenceError: persisted.error,
      };
    }

    if (!persisted.exists || !persisted.record) {
      return {
        ...base,
        effectiveState: 'not_run',
        isValid: false,
      };
    }

    const record = persisted.record;

    if (record.status === 'error') {
      return {
        ...base,
        effectiveState: 'error',
        isValid: false,
        lastRun: record,
      };
    }

    const currentFingerprints = computeFileFingerprints(projectRoot, trackedFiles);
    const changedDuring = diffFingerprints(
      record.fingerprintsBefore,
      record.fingerprintsAfter,
      trackedFiles
    );
    const changedSinceBefore = diffFingerprints(
      record.fingerprintsBefore,
      currentFingerprints,
      trackedFiles
    );

    if (record.changedBetweenBeforeAndAfter || changedDuring.length > 0) {
      const merged = trackedFiles.filter(
        (f) => changedDuring.includes(f) || changedSinceBefore.includes(f)
      );
      return {
        ...base,
        effectiveState: 'stale',
        isValid: false,
        staleReason: 'changed_between_before_and_after',
        changedFiles: merged,
        lastRun: record,
      };
    }

    if (changedSinceBefore.length > 0) {
      return {
        ...base,
        effectiveState: 'stale',
        isValid: false,
        staleReason: 'files_changed_after_run',
        changedFiles: changedSinceBefore,
        lastRun: record,
      };
    }

    return {
      ...base,
      effectiveState: record.status,
      isValid: true,
      lastRun: record,
    };
  }

  async function runCheck() {
    if (isRunning) {
      return {
        busy: true,
        ...getStatus(),
      };
    }

    isRunning = true;
    try {
      const fingerprintsBefore = computeFileFingerprints(projectRoot, trackedFiles);
      const execResult = await runSubprocess({
        execPath,
        commandArgs,
        cwd: projectRoot,
        timeoutMs,
        maxOutputBytes,
      });
      const fingerprintsAfter = computeFileFingerprints(projectRoot, trackedFiles);
      const changedDuring = diffFingerprints(fingerprintsBefore, fingerprintsAfter, trackedFiles);
      const changedBetweenBeforeAndAfter = changedDuring.length > 0;

      const record = {
        projectRoot,
        criterion: ACCEPTANCE_CRITERION,
        command: formatDisplayCommand(commandArgs),
        startedAt: execResult.startedAt,
        finishedAt: execResult.finishedAt,
        durationMs: execResult.durationMs,
        status: execResult.status,
        exitCode: execResult.exitCode,
        signal: execResult.signal,
        timedOut: execResult.timedOut,
        output: execResult.output,
        outputTruncated: execResult.outputTruncated,
        fingerprintsBefore,
        fingerprintsAfter,
        changedBetweenBeforeAndAfter,
      };

      writeLastRunAtomic(projectRoot, record);
    } finally {
      isRunning = false;
    }

    return {
      busy: false,
      ...getStatus(),
    };
  }

  return {
    getStatus,
    runCheck,
  };
}
