import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MISSING_FINGERPRINT = 'MISSING';
const MAX_SYMLINK_HOPS = 20;

function isPathStrictlyInsideRoot(rootDir, candidatePath) {
  const rel = path.relative(rootDir, candidatePath);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}

function isPathInsideOrEqualRoot(rootDir, candidatePath) {
  const rel = path.relative(rootDir, candidatePath);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

export function assertLexicalRelativePathInsideRoot(projectRoot, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw new Error('受跟踪文件路径必须是非空字符串');
  }
  if (relPath.includes('\0')) {
    throw new Error(`受跟踪文件路径包含非法空字节: "${relPath}"`);
  }
  if (path.isAbsolute(relPath) || relPath.startsWith('/') || relPath.startsWith('\\')) {
    throw new Error(`受跟踪文件路径不能为绝对路径: "${relPath}"`);
  }

  const absRoot = path.resolve(projectRoot);
  const resolved = path.resolve(absRoot, relPath);
  if (!isPathStrictlyInsideRoot(absRoot, resolved)) {
    throw new Error(`受跟踪文件路径越出工作区根目录或指向根目录本身: "${relPath}"`);
  }

  return path.relative(absRoot, resolved);
}

function canonicalizeWithExistingAncestor(targetPath, originalRelPath) {
  let cur = targetPath;
  const tail = [];

  while (true) {
    try {
      const realAncestor = fs.realpathSync(cur);
      return tail.length > 0 ? path.join(realAncestor, ...tail.reverse()) : realAncestor;
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        const parent = path.dirname(cur);
        if (parent === cur) {
          return tail.length > 0 ? path.join(cur, ...tail.reverse()) : cur;
        }
        tail.push(path.basename(cur));
        cur = parent;
        continue;
      }
      throw new Error(`无法解析符号链接目标 "${originalRelPath}": ${err?.message || String(err)}`);
    }
  }
}

function resolveSafePathSegments(realRoot, startDir, segments, hops, originalRelPath) {
  let currentDir = startDir;

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const rest = segments.slice(i + 1);
    const isLast = rest.length === 0;
    const candidate = path.join(currentDir, seg);

    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        const finalCandidate = path.join(currentDir, ...segments.slice(i));
        if (!isPathStrictlyInsideRoot(realRoot, finalCandidate)) {
          throw new Error(`受跟踪文件路径越出工作区根目录: "${originalRelPath}"`);
        }
        return { exists: false, resolvedPath: finalCandidate };
      }
      throw new Error(`无法访问受跟踪文件 "${originalRelPath}": ${err?.message || String(err)}`);
    }

    if (stat.isSymbolicLink()) {
      if (hops >= MAX_SYMLINK_HOPS) {
        throw new Error(`符号链接层级过深或存在循环引用: "${originalRelPath}"`);
      }

      let realTarget;
      try {
        realTarget = fs.realpathSync(candidate);
      } catch (err) {
        if (err && err.code === 'ELOOP') {
          throw new Error(`符号链接存在循环引用: "${originalRelPath}"`);
        }
        if (!err || err.code !== 'ENOENT') {
          throw new Error(
            `无法解析符号链接 "${originalRelPath}": ${err?.message || String(err)}`
          );
        }

        // Dangling symlink: resolve target manually via readlinkSync and verify workspace containment
        let rawTarget;
        try {
          rawTarget = fs.readlinkSync(candidate);
        } catch (readlinkErr) {
          throw new Error(
            `无法读取悬空符号链接 "${originalRelPath}": ${readlinkErr?.message || String(readlinkErr)}`
          );
        }

        const resolvedLinkTarget = path.resolve(path.dirname(candidate), rawTarget);
        let safeLinkTarget = resolvedLinkTarget;
        if (!isPathInsideOrEqualRoot(realRoot, safeLinkTarget)) {
          safeLinkTarget = canonicalizeWithExistingAncestor(resolvedLinkTarget, originalRelPath);
        }

        if (!isPathInsideOrEqualRoot(realRoot, safeLinkTarget)) {
          throw new Error(
            `悬空符号链接目标越出工作区根目录: "${originalRelPath}" -> "${rawTarget}"`
          );
        }

        const relToRoot = path.relative(realRoot, safeLinkTarget);
        if (relToRoot === '' && isLast) {
          throw new Error(`悬空符号链接不能指向工作区根目录本身: "${originalRelPath}"`);
        }

        const nextSegments = [
          ...(relToRoot ? relToRoot.split(path.sep).filter(Boolean) : []),
          ...rest,
        ];
        return resolveSafePathSegments(realRoot, realRoot, nextSegments, hops + 1, originalRelPath);
      }

      // Target exists
      if (isLast) {
        if (!isPathStrictlyInsideRoot(realRoot, realTarget)) {
          throw new Error(
            `符号链接目标越出工作区根目录: "${originalRelPath}" -> "${realTarget}"`
          );
        }
        return { exists: true, resolvedPath: realTarget };
      }

      if (!isPathInsideOrEqualRoot(realRoot, realTarget)) {
        throw new Error(
          `符号链接目录越出工作区根目录: "${originalRelPath}" -> "${realTarget}"`
        );
      }

      let targetStat;
      try {
        targetStat = fs.statSync(realTarget);
      } catch (statErr) {
        if (statErr && statErr.code === 'ENOENT') {
          const finalCandidate = path.join(realTarget, ...rest);
          if (!isPathStrictlyInsideRoot(realRoot, finalCandidate)) {
            throw new Error(`受跟踪文件路径越出工作区根目录: "${originalRelPath}"`);
          }
          return { exists: false, resolvedPath: finalCandidate };
        }
        throw new Error(
          `无法读取符号链接目标 "${originalRelPath}": ${statErr?.message || String(statErr)}`
        );
      }

      if (!targetStat.isDirectory()) {
        const finalCandidate = path.join(realTarget, ...rest);
        if (!isPathStrictlyInsideRoot(realRoot, finalCandidate)) {
          throw new Error(`受跟踪文件路径越出工作区根目录: "${originalRelPath}"`);
        }
        return { exists: false, resolvedPath: finalCandidate };
      }

      return resolveSafePathSegments(realRoot, realTarget, rest, hops + 1, originalRelPath);
    }

    // Non-symlink entry
    if (isLast) {
      const realFinal = fs.realpathSync(candidate);
      if (!isPathStrictlyInsideRoot(realRoot, realFinal)) {
        throw new Error(`受跟踪文件路径越出工作区根目录: "${originalRelPath}"`);
      }
      return { exists: true, resolvedPath: realFinal };
    }

    if (!stat.isDirectory()) {
      const finalCandidate = path.join(candidate, ...rest);
      if (!isPathStrictlyInsideRoot(realRoot, finalCandidate)) {
        throw new Error(`受跟踪文件路径越出工作区根目录: "${originalRelPath}"`);
      }
      return { exists: false, resolvedPath: finalCandidate };
    }

    currentDir = candidate;
  }

  throw new Error(`受跟踪文件路径无效: "${originalRelPath}"`);
}

export function resolveSafeTrackedFilePath(projectRoot, relPath) {
  const normalizedRel = assertLexicalRelativePathInsideRoot(projectRoot, relPath);
  const realRoot = fs.realpathSync(projectRoot);
  const segments = normalizedRel.split(path.sep).filter(Boolean);
  return resolveSafePathSegments(realRoot, realRoot, segments, 0, relPath);
}

export function computeFileFingerprints(projectRoot, trackedFiles) {
  const result = {};
  for (const relPath of trackedFiles) {
    const resolved = resolveSafeTrackedFilePath(projectRoot, relPath);
    if (!resolved.exists) {
      result[relPath] = MISSING_FINGERPRINT;
      continue;
    }
    try {
      const buf = fs.readFileSync(resolved.resolvedPath);
      result[relPath] = crypto.createHash('sha256').update(buf).digest('hex');
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        result[relPath] = MISSING_FINGERPRINT;
        continue;
      }
      throw new Error(`无法读取受跟踪文件 "${relPath}": ${err?.message || String(err)}`);
    }
  }
  return result;
}

export function diffFingerprints(baseline, current, trackedFiles) {
  const changed = [];
  for (const relPath of trackedFiles) {
    if ((baseline?.[relPath] ?? MISSING_FINGERPRINT) !== (current?.[relPath] ?? MISSING_FINGERPRINT)) {
      changed.push(relPath);
    }
  }
  return changed;
}
