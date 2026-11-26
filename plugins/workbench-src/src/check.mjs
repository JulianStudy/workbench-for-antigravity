import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { loadWorkspaceConfig } from './config.mjs';
import { computeFileFingerprints, diffFingerprints } from './fingerprint.mjs';
import { readResults, updateCheckResultAtomic } from './results.mjs';

export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024;
export const DEFAULT_TRUNCATION_SUFFIX = '\n...[输出已截断]';
export const MID_BATCH_SKIP_REASON = '运行期间该项配置已变更，已跳过执行，请确认后重新运行';

function zeroCounts() {
  return {
    total: 0,
    not_run: 0,
    passed: 0,
    failed: 0,
    stale: 0,
    error: 0,
  };
}

function formatCommandDisplay(command) {
  return command
    .map((arg) => (/[\s"'\\]/.test(arg) ? JSON.stringify(arg) : arg))
    .join(' ');
}

function trimStringToMaxUtf8Bytes(str, maxBytes) {
  let result = str;
  if (Buffer.byteLength(result, 'utf8') <= maxBytes) {
    return result;
  }
  const chars = Array.from(result);
  while (chars.length > 0 && Buffer.byteLength(chars.join(''), 'utf8') > maxBytes) {
    chars.pop();
  }
  return chars.join('');
}

export function truncateUtf8Bytes(input, maxBytes, suffix = DEFAULT_TRUNCATION_SUFFIX) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''), 'utf8');
  if (maxBytes <= 0) {
    return { text: '', truncated: buf.length > 0 };
  }
  if (buf.length <= maxBytes) {
    return { text: buf.toString('utf8'), truncated: false };
  }

  const suffixBuf = Buffer.from(suffix, 'utf8');
  if (maxBytes < suffixBuf.length) {
    const decoder = new StringDecoder('utf8');
    const partial = decoder.write(suffixBuf.subarray(0, maxBytes));
    return {
      text: trimStringToMaxUtf8Bytes(partial, maxBytes),
      truncated: true,
    };
  }

  const prefixBudget = maxBytes - suffixBuf.length;
  const decoder = new StringDecoder('utf8');
  const rawPrefix = decoder.write(buf.subarray(0, prefixBudget));
  const safePrefix = trimStringToMaxUtf8Bytes(rawPrefix, prefixBudget);
  return {
    text: `${safePrefix}${suffix}`,
    truncated: true,
  };
}

function buildChildEnv(isNodeCommand) {
  const env = {
    ...process.env,
    NO_COLOR: '1',
    NODE_DISABLE_COLORS: '1',
    FORCE_COLOR: '0',
  };
  delete env.NODE_TEST_CONTEXT;
  if (isNodeCommand && (process.versions?.electron || process.env.ELECTRON_RUN_AS_NODE)) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  return env;
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

function runSubprocess({ command, cwd, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const startHr = Date.now();
    const chunks = [];
    const maxCollectBytes = maxOutputBytes + 4;
    let collectedBytes = 0;
    let outputOverflowed = false;
    let timedOut = false;
    let settled = false;
    let killGraceTimer = null;

    const isNodeCommand = command[0] === 'node';
    const execCmd = isNodeCommand ? process.execPath : command[0];
    const execArgs = command.slice(1);

    const child = spawn(execCmd, execArgs, {
      cwd,
      env: buildChildEnv(isNodeCommand),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onChunk = (buf) => {
      if (collectedBytes < maxCollectBytes) {
        const remaining = maxCollectBytes - collectedBytes;
        chunks.push(buf.length > remaining ? buf.subarray(0, remaining) : buf);
        collectedBytes += buf.length;
        if (collectedBytes > maxOutputBytes) {
          outputOverflowed = true;
        }
      } else {
        outputOverflowed = true;
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
      const fullBuf = Buffer.concat(chunks);
      const decoded = truncateUtf8Bytes(fullBuf, maxOutputBytes);
      let output = decoded.text;
      const truncated = decoded.truncated || outputOverflowed;

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

function serializeLastRun(record, includeOutput) {
  if (!record || typeof record !== 'object') return null;
  const summary = {
    startedAt: record.startedAt ?? null,
    finishedAt: record.finishedAt ?? null,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : null,
    status: record.status ?? 'error',
    exitCode: record.exitCode ?? null,
    signal: record.signal ?? null,
    timedOut: Boolean(record.timedOut),
    hasOutput: Boolean(record.output),
    outputTruncated: Boolean(record.outputTruncated),
    changedBetweenBeforeAndAfter: Boolean(record.changedBetweenBeforeAndAfter),
    projectRoot: record.projectRoot ?? null,
    commandDisplay: record.commandDisplay ?? null,
    configFingerprint: record.configFingerprint ?? null,
  };
  if (includeOutput) {
    summary.output = typeof record.output === 'string' ? record.output : '';
  }
  return summary;
}

export function createWorkbenchRunner({
  projectRoot,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
}) {
  let isRunning = false;
  let runningCheckId = null;
  let runningBatch = false;
  let lastBatchSkipped = [];

  function evaluateSingleCheck(check, record, { persistenceCorrupt, persistenceError, includeOutput }) {
    const base = {
      id: check.id,
      name: check.name,
      command: [...check.command],
      commandDisplay: formatCommandDisplay(check.command),
      files: [...check.files],
      timeoutMs: check.timeoutMs,
      configFingerprint: check.configFingerprint,
      isRunning: isRunning && runningCheckId === check.id,
      staleReason: null,
      changedFiles: [],
      checkError: null,
      lastRun: null,
    };

    if (persistenceCorrupt) {
      return {
        ...base,
        effectiveState: 'error',
        isValid: false,
        checkError: persistenceError,
      };
    }

    let currentFingerprints;
    try {
      currentFingerprints = computeFileFingerprints(projectRoot, check.files);
    } catch (err) {
      return {
        ...base,
        effectiveState: 'error',
        isValid: false,
        checkError: err instanceof Error ? err.message : String(err),
        lastRun: serializeLastRun(record, includeOutput),
      };
    }

    if (!record || typeof record !== 'object' || typeof record.status !== 'string') {
      return {
        ...base,
        effectiveState: 'not_run',
        isValid: false,
      };
    }

    const lastRun = serializeLastRun(record, includeOutput);

    if (record.configFingerprint !== check.configFingerprint) {
      return {
        ...base,
        effectiveState: 'stale',
        isValid: false,
        staleReason: 'config_changed',
        changedFiles: [],
        lastRun,
      };
    }

    if (record.status === 'error') {
      return {
        ...base,
        effectiveState: 'error',
        isValid: false,
        checkError: record.checkError || null,
        lastRun,
      };
    }

    const changedDuring = diffFingerprints(
      record.fingerprintsBefore,
      record.fingerprintsAfter,
      check.files
    );
    const changedSinceBefore = diffFingerprints(
      record.fingerprintsBefore,
      currentFingerprints,
      check.files
    );

    if (record.changedBetweenBeforeAndAfter || changedDuring.length > 0) {
      const merged = check.files.filter(
        (f) => changedDuring.includes(f) || changedSinceBefore.includes(f)
      );
      return {
        ...base,
        effectiveState: 'stale',
        isValid: false,
        staleReason: 'changed_between_before_and_after',
        changedFiles: merged,
        lastRun,
      };
    }

    if (changedSinceBefore.length > 0) {
      return {
        ...base,
        effectiveState: 'stale',
        isValid: false,
        staleReason: 'files_changed_after_run',
        changedFiles: changedSinceBefore,
        lastRun,
      };
    }

    return {
      ...base,
      effectiveState: record.status,
      isValid: true,
      lastRun,
    };
  }

  function getStatus({ id } = {}) {
    const config = loadWorkspaceConfig(projectRoot);
    if (!config.ok) {
      if (id !== undefined && id !== null) {
        return {
          ok: false,
          configOk: false,
          configError: config.error,
          error: config.error,
          projectRoot,
          check: null,
          isRunning,
          runningCheckId,
          runningBatch,
          persistenceError: null,
          skippedChecks: [...lastBatchSkipped],
        };
      }
      return {
        ok: true,
        configOk: false,
        configError: config.error,
        projectRoot,
        checks: [],
        counts: zeroCounts(),
        isRunning,
        runningCheckId,
        runningBatch,
        persistenceError: null,
        skippedChecks: [...lastBatchSkipped],
      };
    }

    const persisted = readResults(projectRoot);
    const persistenceError = persisted.corrupt ? persisted.error : null;
    const recordsMap =
      persisted.exists && !persisted.corrupt && persisted.data ? persisted.data.checks : {};

    if (id !== undefined && id !== null) {
      const target = config.checks.find((c) => c.id === id);
      if (!target) {
        return {
          ok: false,
          configOk: true,
          configError: null,
          error: `未找到检查项: "${id}"`,
          projectRoot,
          check: null,
          isRunning,
          runningCheckId,
          runningBatch,
          persistenceError,
          skippedChecks: [...lastBatchSkipped],
        };
      }

      const detailCheck = evaluateSingleCheck(target, recordsMap[target.id], {
        persistenceCorrupt: persisted.corrupt,
        persistenceError,
        includeOutput: true,
      });

      return {
        ok: true,
        configOk: true,
        configError: null,
        error: null,
        projectRoot,
        check: detailCheck,
        isRunning,
        runningCheckId,
        runningBatch,
        persistenceError,
        skippedChecks: [...lastBatchSkipped],
      };
    }

    const checks = config.checks.map((check) =>
      evaluateSingleCheck(check, recordsMap[check.id], {
        persistenceCorrupt: persisted.corrupt,
        persistenceError,
        includeOutput: false,
      })
    );

    const counts = zeroCounts();
    counts.total = checks.length;
    for (const check of checks) {
      if (Object.prototype.hasOwnProperty.call(counts, check.effectiveState)) {
        counts[check.effectiveState] += 1;
      }
    }

    return {
      ok: true,
      configOk: true,
      configError: null,
      projectRoot,
      checks,
      counts,
      isRunning,
      runningCheckId,
      runningBatch,
      persistenceError,
      skippedChecks: [...lastBatchSkipped],
    };
  }

  async function executeAndPersistSingleCheck(check) {
    const commandDisplay = formatCommandDisplay(check.command);
    let fingerprintsBefore;
    try {
      fingerprintsBefore = computeFileFingerprints(projectRoot, check.files);
    } catch (err) {
      const now = new Date().toISOString();
      const message = err instanceof Error ? err.message : String(err);
      const errorRecord = {
        id: check.id,
        name: check.name,
        projectRoot,
        command: [...check.command],
        commandDisplay,
        files: [...check.files],
        timeoutMs: check.timeoutMs,
        configFingerprint: check.configFingerprint,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        status: 'error',
        exitCode: null,
        signal: null,
        timedOut: false,
        output: message,
        outputTruncated: false,
        fingerprintsBefore: null,
        fingerprintsAfter: null,
        changedBetweenBeforeAndAfter: false,
        checkError: message,
      };
      updateCheckResultAtomic(projectRoot, check.id, errorRecord);
      return;
    }

    const execResult = await runSubprocess({
      command: check.command,
      cwd: projectRoot,
      timeoutMs: check.timeoutMs,
      maxOutputBytes,
    });

    let fingerprintsAfter = null;
    let changedBetweenBeforeAndAfter = false;
    let checkError = null;
    let status = execResult.status;
    let output = execResult.output;

    try {
      fingerprintsAfter = computeFileFingerprints(projectRoot, check.files);
      const changedDuring = diffFingerprints(fingerprintsBefore, fingerprintsAfter, check.files);
      changedBetweenBeforeAndAfter = changedDuring.length > 0;
    } catch (err) {
      checkError = err instanceof Error ? err.message : String(err);
      status = 'error';
      output = output ? `${output}\n${checkError}` : checkError;
    }

    const record = {
      id: check.id,
      name: check.name,
      projectRoot,
      command: [...check.command],
      commandDisplay,
      files: [...check.files],
      timeoutMs: check.timeoutMs,
      configFingerprint: check.configFingerprint,
      startedAt: execResult.startedAt,
      finishedAt: execResult.finishedAt,
      durationMs: execResult.durationMs,
      status,
      exitCode: execResult.exitCode,
      signal: execResult.signal,
      timedOut: execResult.timedOut,
      output,
      outputTruncated: execResult.outputTruncated,
      fingerprintsBefore,
      fingerprintsAfter,
      changedBetweenBeforeAndAfter,
      checkError,
    };

    updateCheckResultAtomic(projectRoot, check.id, record);
  }

  async function runCheck(id) {
    if (isRunning) {
      return {
        busy: true,
        ...getStatus(),
      };
    }

    if (typeof id !== 'string' || !id.trim()) {
      return {
        ...getStatus(),
        ok: false,
        busy: false,
        error: '必须提供有效的检查项 id。',
      };
    }

    const config = loadWorkspaceConfig(projectRoot);
    if (!config.ok) {
      return {
        ...getStatus(),
        ok: false,
        busy: false,
        error: config.error,
      };
    }

    const target = config.checks.find((c) => c.id === id);
    if (!target) {
      return {
        ...getStatus(),
        ok: false,
        busy: false,
        error: `未找到检查项: "${id}"`,
      };
    }

    isRunning = true;
    runningCheckId = target.id;
    runningBatch = false;
    lastBatchSkipped = [];

    try {
      await executeAndPersistSingleCheck(target);
    } finally {
      isRunning = false;
      runningCheckId = null;
      runningBatch = false;
    }

    return {
      busy: false,
      ranCheckId: target.id,
      ...getStatus(),
      checkDetail: getStatus({ id: target.id }),
    };
  }

  async function runAll() {
    if (isRunning) {
      return {
        busy: true,
        ...getStatus(),
      };
    }

    const initialConfig = loadWorkspaceConfig(projectRoot);
    if (!initialConfig.ok) {
      return {
        ...getStatus(),
        ok: false,
        busy: false,
        error: initialConfig.error,
        skippedChecks: [],
      };
    }

    const plan = initialConfig.checks.map((c) => ({
      id: c.id,
      name: c.name,
      configFingerprint: c.configFingerprint,
    }));

    isRunning = true;
    runningBatch = true;
    runningCheckId = null;
    lastBatchSkipped = [];
    const skipped = [];

    try {
      for (const planned of plan) {
        const latestConfig = loadWorkspaceConfig(projectRoot);
        const current = latestConfig.ok
          ? latestConfig.checks.find((c) => c.id === planned.id)
          : null;

        if (
          !latestConfig.ok ||
          !current ||
          current.configFingerprint !== planned.configFingerprint
        ) {
          skipped.push({
            id: planned.id,
            name: planned.name,
            reason: MID_BATCH_SKIP_REASON,
          });
          lastBatchSkipped = [...skipped];
          continue;
        }

        runningCheckId = current.id;
        await executeAndPersistSingleCheck(current);
      }
    } finally {
      isRunning = false;
      runningBatch = false;
      runningCheckId = null;
    }

    return {
      busy: false,
      skippedChecks: [...skipped],
      ...getStatus(),
    };
  }

  return {
    getStatus,
    runCheck,
    runAll,
    isBusy: () => isRunning,
  };
}
