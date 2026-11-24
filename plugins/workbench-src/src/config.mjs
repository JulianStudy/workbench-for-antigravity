import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertLexicalRelativePathInsideRoot } from './fingerprint.mjs';

export const DEFAULT_TIMEOUT_MS = 15000;
export const CONFIG_FILE_NAME = 'workbench.json';
export const CHECK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function computeConfigFingerprint({ command, files, timeoutMs }) {
  const canonical = JSON.stringify({
    command,
    files,
    timeoutMs,
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function loadWorkspaceConfig(projectRoot) {
  const configPath = path.join(projectRoot, CONFIG_FILE_NAME);
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {
        ok: false,
        error: `缺少配置文件 ${CONFIG_FILE_NAME}（请在工作区根目录创建 ${CONFIG_FILE_NAME} 并定义 checks 列表）。`,
        checks: [],
      };
    }
    return {
      ok: false,
      error: `无法读取配置文件 ${CONFIG_FILE_NAME}: ${err?.message || String(err)}`,
      checks: [],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `配置文件 ${CONFIG_FILE_NAME} JSON 解析失败: ${err?.message || String(err)}`,
      checks: [],
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `配置文件 ${CONFIG_FILE_NAME} 顶层必须是 JSON 对象。`,
      checks: [],
    };
  }

  if (!Array.isArray(parsed.checks) || parsed.checks.length === 0) {
    return {
      ok: false,
      error: `配置文件 ${CONFIG_FILE_NAME} 的 checks 必须是非空数组。`,
      checks: [],
    };
  }

  const normalizedChecks = [];
  const seenIds = new Set();

  for (let idx = 0; idx < parsed.checks.length; idx += 1) {
    const item = parsed.checks[idx];
    const label = `checks[${idx}]`;

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return {
        ok: false,
        error: `${label} 必须是对象。`,
        checks: [],
      };
    }

    if (typeof item.id !== 'string' || !CHECK_ID_PATTERN.test(item.id)) {
      return {
        ok: false,
        error: `${label}.id 无效：必须匹配 /^[a-z0-9][a-z0-9_-]{0,63}$/（仅限小写字母、数字、-、_）。`,
        checks: [],
      };
    }

    if (seenIds.has(item.id)) {
      return {
        ok: false,
        error: `存在重复的检查项 id: "${item.id}"。`,
        checks: [],
      };
    }
    seenIds.add(item.id);

    if (typeof item.name !== 'string' || !item.name.trim()) {
      return {
        ok: false,
        error: `${label} ("${item.id}") 的 name 必须是非空字符串。`,
        checks: [],
      };
    }

    if (!Array.isArray(item.command) || item.command.length === 0) {
      return {
        ok: false,
        error: `${label} ("${item.id}") 的 command 必须是非空字符串数组。`,
        checks: [],
      };
    }

    for (let argIdx = 0; argIdx < item.command.length; argIdx += 1) {
      if (typeof item.command[argIdx] !== 'string') {
        return {
          ok: false,
          error: `${label} ("${item.id}") 的 command[${argIdx}] 必须是字符串。`,
          checks: [],
        };
      }
    }

    if (!item.command[0].trim()) {
      return {
        ok: false,
        error: `${label} ("${item.id}") 的 command[0] 必须是非空可执行程序名。`,
        checks: [],
      };
    }

    if (!Array.isArray(item.files) || item.files.length === 0) {
      return {
        ok: false,
        error: `${label} ("${item.id}") 的 files 必须是非空字符串数组。`,
        checks: [],
      };
    }

    for (let fIdx = 0; fIdx < item.files.length; fIdx += 1) {
      const relPath = item.files[fIdx];
      if (typeof relPath !== 'string' || !relPath.trim()) {
        return {
          ok: false,
          error: `${label} ("${item.id}") 的 files[${fIdx}] 必须是非空字符串。`,
          checks: [],
        };
      }
      try {
        assertLexicalRelativePathInsideRoot(projectRoot, relPath);
      } catch (err) {
        return {
          ok: false,
          error: `${label} ("${item.id}") 的 files[${fIdx}] 非法: ${err?.message || String(err)}`,
          checks: [],
        };
      }
    }

    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (item.timeoutMs !== undefined) {
      if (!Number.isInteger(item.timeoutMs) || item.timeoutMs <= 0) {
        return {
          ok: false,
          error: `${label} ("${item.id}") 的 timeoutMs 必须是正整数。`,
          checks: [],
        };
      }
      timeoutMs = item.timeoutMs;
    }

    const command = [...item.command];
    const files = [...item.files];
    const configFingerprint = computeConfigFingerprint({ command, files, timeoutMs });

    normalizedChecks.push({
      id: item.id,
      name: item.name.trim(),
      command,
      files,
      timeoutMs,
      configFingerprint,
    });
  }

  return {
    ok: true,
    error: null,
    checks: normalizedChecks,
  };
}
