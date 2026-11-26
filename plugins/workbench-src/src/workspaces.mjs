import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TRUSTED_WORKSPACES_SCHEMA_VERSION = 1;
export const TRUSTED_WORKSPACES_FILE_NAME = 'trusted-workspaces.json';
const WORKSPACE_ID_RE = /^[0-9a-f]{12}$/;

export function getTrustedWorkspacesFilePath(pluginDataDir) {
  return path.join(pluginDataDir, TRUSTED_WORKSPACES_FILE_NAME);
}

export function computeWorkspaceId(realRoot) {
  return crypto.createHash('sha256').update(String(realRoot), 'utf8').digest('hex').slice(0, 12);
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function isValidWorkspaceEntry(entry) {
  if (!isPlainObject(entry)) return false;
  if (typeof entry.id !== 'string' || !WORKSPACE_ID_RE.test(entry.id)) return false;
  if (typeof entry.path !== 'string' || !entry.path.trim() || entry.path.includes('\0')) return false;
  if (!path.isAbsolute(entry.path) || path.dirname(entry.path) === entry.path) return false;
  if (entry.id !== computeWorkspaceId(entry.path)) return false;
  if (typeof entry.label !== 'string' || !entry.label.trim()) return false;
  if (typeof entry.addedAt !== 'string' || !entry.addedAt.trim()) return false;
  return true;
}

function writeTrustedWorkspacesAtomic(pluginDataDir, workspaces) {
  fs.mkdirSync(pluginDataDir, { recursive: true });
  const targetPath = getTrustedWorkspacesFilePath(pluginDataDir);
  const rand = crypto.randomBytes(6).toString('hex');
  const tmpPath = path.join(pluginDataDir, `.trusted-workspaces.${process.pid}.${rand}.tmp`);

  const payload = JSON.stringify(
    {
      schemaVersion: TRUSTED_WORKSPACES_SCHEMA_VERSION,
      workspaces,
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

export function readTrustedWorkspaces(pluginDataDir) {
  const filePath = getTrustedWorkspacesFilePath(pluginDataDir);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {
        exists: false,
        corrupt: false,
        workspaces: [],
        error: null,
      };
    }
    return {
      exists: true,
      corrupt: true,
      workspaces: [],
      error: `无法读取受信任工作区列表（${TRUSTED_WORKSPACES_FILE_NAME}）: ${err?.message || String(err)}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      exists: true,
      corrupt: true,
      workspaces: [],
      error: `受信任工作区列表 JSON 损坏（${TRUSTED_WORKSPACES_FILE_NAME}）: ${err?.message || String(err)}`,
    };
  }

  if (
    !isPlainObject(parsed) ||
    parsed.schemaVersion !== TRUSTED_WORKSPACES_SCHEMA_VERSION ||
    !Array.isArray(parsed.workspaces)
  ) {
    return {
      exists: true,
      corrupt: true,
      workspaces: [],
      error: `受信任工作区列表结构无效（${TRUSTED_WORKSPACES_FILE_NAME}），请检查或重新初始化。`,
    };
  }

  const deduped = [];
  const seenIds = new Set();
  for (const entry of parsed.workspaces) {
    if (!isValidWorkspaceEntry(entry)) {
      return {
        exists: true,
        corrupt: true,
        workspaces: [],
        error: `受信任工作区列表中存在格式无效的条目（${TRUSTED_WORKSPACES_FILE_NAME}）。`,
      };
    }
    if (seenIds.has(entry.id)) {
      continue;
    }
    seenIds.add(entry.id);
    deduped.push({
      id: entry.id,
      path: entry.path,
      label: entry.label,
      addedAt: entry.addedAt,
    });
  }

  return {
    exists: true,
    corrupt: false,
    workspaces: deduped,
    error: null,
  };
}

export function addTrustedWorkspace(pluginDataDir, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new Error('必须提供有效的工作区目录路径。');
  }
  if (rawPath.includes('\0')) {
    throw new Error('工作区路径包含非法空字符（NUL）。');
  }

  const trimmed = rawPath.trim();
  let realRoot;
  try {
    realRoot = fs.realpathSync(trimmed);
  } catch (err) {
    throw new Error(
      `工作区目录不存在或无法访问: "${trimmed}" (${err instanceof Error ? err.message : String(err)})`
    );
  }

  const stat = fs.statSync(realRoot);
  if (!stat.isDirectory()) {
    throw new Error(`目标路径不是目录: "${realRoot}"`);
  }

  if (path.dirname(realRoot) === realRoot) {
    throw new Error('不能将文件系统根目录添加为受信任工作区，请选择具体项目目录。');
  }

  const existing = readTrustedWorkspaces(pluginDataDir);
  if (existing.corrupt) {
    throw new Error(existing.error);
  }

  const id = computeWorkspaceId(realRoot);
  const alreadyTrusted = existing.workspaces.find((w) => w.id === id);
  if (alreadyTrusted) {
    return {
      workspace: alreadyTrusted,
      workspaces: existing.workspaces,
    };
  }

  const workspace = {
    id,
    path: realRoot,
    label: path.basename(realRoot) || realRoot,
    addedAt: new Date().toISOString(),
  };

  const workspaces = [...existing.workspaces, workspace];
  writeTrustedWorkspacesAtomic(pluginDataDir, workspaces);

  return {
    workspace,
    workspaces,
  };
}

export function removeTrustedWorkspace(pluginDataDir, workspaceId) {
  const existing = readTrustedWorkspaces(pluginDataDir);
  if (existing.corrupt) {
    throw new Error(existing.error);
  }
  if (!workspaceId || typeof workspaceId !== 'string' || !existing.exists) {
    return {
      removed: false,
      workspaces: existing.workspaces,
    };
  }

  const nextWorkspaces = existing.workspaces.filter((w) => w.id !== workspaceId);
  if (nextWorkspaces.length === existing.workspaces.length) {
    return {
      removed: false,
      workspaces: existing.workspaces,
    };
  }

  writeTrustedWorkspacesAtomic(pluginDataDir, nextWorkspaces);
  return {
    removed: true,
    workspaces: nextWorkspaces,
  };
}

export function findTrustedWorkspace(pluginDataDir, workspaceId) {
  if (!workspaceId || typeof workspaceId !== 'string') {
    return null;
  }
  const existing = readTrustedWorkspaces(pluginDataDir);
  if (existing.corrupt) {
    return null;
  }
  return existing.workspaces.find((w) => w.id === workspaceId) || null;
}

export function enrichWorkspaceList(workspaces = []) {
  return workspaces.map((ws) => {
    let exists = false;
    let hasConfig = false;
    try {
      exists = fs.statSync(ws.path).isDirectory();
    } catch {
      exists = false;
    }
    if (exists) {
      try {
        hasConfig = fs.statSync(path.join(ws.path, 'workbench.json')).isFile();
      } catch {
        hasConfig = false;
      }
    }
    return {
      id: ws.id,
      path: ws.path,
      label: ws.label,
      addedAt: ws.addedAt,
      exists,
      hasConfig,
    };
  });
}
