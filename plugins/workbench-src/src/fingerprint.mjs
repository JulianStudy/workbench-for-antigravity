import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MISSING_FINGERPRINT = 'MISSING';

export const DEFAULT_TRACKED_FILES = [
  'src/format-total.mjs',
  'test/format-total.test.mjs',
];

export function hashFileOrMissing(absolutePath) {
  try {
    const buf = fs.readFileSync(absolutePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return MISSING_FINGERPRINT;
    }
    throw err;
  }
}

export function computeFileFingerprints(projectRoot, trackedFiles = DEFAULT_TRACKED_FILES) {
  const result = {};
  for (const relPath of trackedFiles) {
    const absPath = path.join(projectRoot, relPath);
    result[relPath] = hashFileOrMissing(absPath);
  }
  return result;
}

export function diffFingerprints(baseline, current, trackedFiles = DEFAULT_TRACKED_FILES) {
  const changed = [];
  for (const relPath of trackedFiles) {
    if ((baseline?.[relPath] ?? MISSING_FINGERPRINT) !== (current?.[relPath] ?? MISSING_FINGERPRINT)) {
      changed.push(relPath);
    }
  }
  return changed;
}
