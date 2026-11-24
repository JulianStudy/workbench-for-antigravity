import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 2;
export const RESULTS_DIR_NAME = '.workbench';
export const RESULTS_FILE_NAME = 'results.json';

export function getResultsFilePath(projectRoot) {
  return path.join(projectRoot, RESULTS_DIR_NAME, RESULTS_FILE_NAME);
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function isValidResultsPayload(obj) {
  if (!isPlainObject(obj)) return false;
  if (obj.schemaVersion !== SCHEMA_VERSION) return false;
  if (!isPlainObject(obj.checks)) return false;
  return true;
}

export function readResults(projectRoot) {
  const filePath = getResultsFilePath(projectRoot);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {
        exists: false,
        corrupt: false,
        data: null,
        error: null,
      };
    }
    return {
      exists: true,
      corrupt: true,
      data: null,
      error: `无法读取持久化记录（.workbench/results.json）: ${err?.message || String(err)}`,
    };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!isValidResultsPayload(parsed)) {
      return {
        exists: true,
        corrupt: true,
        data: null,
        error: '持久化记录结构无效（.workbench/results.json），请重新运行检查覆盖。',
      };
    }
    return {
      exists: true,
      corrupt: false,
      data: parsed,
      error: null,
    };
  } catch (err) {
    return {
      exists: true,
      corrupt: true,
      data: null,
      error: `持久化记录 JSON 损坏（.workbench/results.json）: ${err?.message || String(err)}`,
    };
  }
}

export function updateCheckResultAtomic(projectRoot, checkId, record) {
  const resultsDir = path.join(projectRoot, RESULTS_DIR_NAME);
  fs.mkdirSync(resultsDir, { recursive: true });

  const existing = readResults(projectRoot);
  const existingChecks =
    existing.exists && !existing.corrupt && existing.data ? { ...existing.data.checks } : {};

  existingChecks[checkId] = record;

  const targetPath = path.join(resultsDir, RESULTS_FILE_NAME);
  const rand = crypto.randomBytes(6).toString('hex');
  const tmpPath = path.join(resultsDir, `.results.${process.pid}.${rand}.tmp`);

  const payload = JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      checks: existingChecks,
    },
    null,
    2
  );

  try {
    fs.writeFileSync(tmpPath, `${payload}\n`, 'utf8');
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }

  return targetPath;
}
