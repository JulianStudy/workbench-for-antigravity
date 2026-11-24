import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 1;
export const RESULTS_DIR_NAME = '.workbench';
export const RESULTS_FILE_NAME = 'last-run.json';

export function getResultsFilePath(projectRoot) {
  return path.join(projectRoot, RESULTS_DIR_NAME, RESULTS_FILE_NAME);
}

export function writeLastRunAtomic(projectRoot, record) {
  const resultsDir = path.join(projectRoot, RESULTS_DIR_NAME);
  fs.mkdirSync(resultsDir, { recursive: true });

  const targetPath = path.join(resultsDir, RESULTS_FILE_NAME);
  const rand = crypto.randomBytes(6).toString('hex');
  const tmpPath = path.join(resultsDir, `.last-run.${process.pid}.${rand}.tmp`);

  const payload = JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      ...record,
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

function isValidRecord(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (obj.schemaVersion !== SCHEMA_VERSION) return false;
  if (!['passed', 'failed', 'error'].includes(obj.status)) return false;
  if (typeof obj.projectRoot !== 'string') return false;
  if (typeof obj.finishedAt !== 'string') return false;
  return true;
}

export function readLastRun(projectRoot) {
  const filePath = getResultsFilePath(projectRoot);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { exists: false, corrupt: false, record: null, error: null };
    }
    return {
      exists: true,
      corrupt: true,
      record: null,
      error: `无法读取持久化记录: ${err?.message || String(err)}`,
    };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!isValidRecord(parsed)) {
      return {
        exists: true,
        corrupt: true,
        record: null,
        error: '持久化记录结构无效（.workbench/last-run.json），请重新运行检查覆盖。',
      };
    }
    return { exists: true, corrupt: false, record: parsed, error: null };
  } catch (err) {
    return {
      exists: true,
      corrupt: true,
      record: null,
      error: `持久化记录 JSON 损坏（.workbench/last-run.json）: ${err?.message || String(err)}`,
    };
  }
}
