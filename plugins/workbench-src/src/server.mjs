import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  getUiCapability,
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import {
  isInstalledUnderWorkspacePluginsDir,
  resolveProjectRootFromPluginDir,
  validateRootBinding,
} from './root.mjs';
import { createWorkbenchRunner } from './check.mjs';
import {
  addTrustedWorkspace,
  enrichWorkspaceList,
  readTrustedWorkspaces,
  removeTrustedWorkspace,
} from './workspaces.mjs';

export const WORKBENCH_UI_URI = 'ui://workbench/pane.html';
export const DEFAULT_ENTRY_TITLE = 'Workbench';
export const UI_HOST_REQUIRED_ERROR =
  '当前 MCP 客户端未声明 MCP App UI 能力（如 CLI / 非 UI 宿主），已拒绝工作区信任变更与命令执行。请在 Antigravity 桌面侧栏手动操作。';

const MISSING_PLUGIN_DATA_ERROR = '缺少可写的 PLUGIN_DATA 目录，无法保存受信任工作区列表。';
const UNTRUSTED_WORKSPACE_BINDING_ERROR = '所选工作区不在受信任列表中，请重新选择或添加。';
const UNBOUND_EXECUTION_ERROR = '当前侧栏未绑定受信任工作区，已禁用执行。';
const BUSY_REMOVE_WORKSPACE_ERROR = '该工作区有检查正在运行，请等待完成后再移除。';
const WORKSPACE_MODE_ADD_ERROR = '当前处于工作区绑定模式，不支持添加其他工作区。';
const WORKSPACE_MODE_REMOVE_ERROR = '当前处于工作区绑定模式，不支持移除工作区。';

export function isUiCapableClient(clientCapabilities) {
  const uiCap = getUiCapability(clientCapabilities);
  return Boolean(
    uiCap && Array.isArray(uiCap.mimeTypes) && uiCap.mimeTypes.includes(RESOURCE_MIME_TYPE)
  );
}

const STATE_LABELS = {
  not_run: '未运行',
  passed: '通过',
  failed: '失败',
  stale: '已过期',
  error: '执行错误',
};

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

export function parseServerArgs(argv = []) {
  let expectedRoot = null;
  let entryTitle = DEFAULT_ENTRY_TITLE;
  let pluginDataDir = null;
  let mode = null;
  let hasPluginData = false;
  let hasMode = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--expected-root') {
      const next = argv[i + 1];
      if (typeof next === 'string' && !next.startsWith('--')) {
        expectedRoot = next.trim() ? next : null;
        i += 1;
      } else {
        expectedRoot = null;
      }
    } else if (arg.startsWith('--expected-root=')) {
      const val = arg.slice('--expected-root='.length);
      expectedRoot = val.trim() ? val : null;
    } else if (arg === '--entry-title') {
      const next = argv[i + 1];
      if (typeof next === 'string' && !next.startsWith('--')) {
        entryTitle = next.trim() || DEFAULT_ENTRY_TITLE;
        i += 1;
      }
    } else if (arg.startsWith('--entry-title=')) {
      const val = arg.slice('--entry-title='.length).trim();
      entryTitle = val || DEFAULT_ENTRY_TITLE;
    } else if (arg === '--plugin-data') {
      hasPluginData = true;
      const next = argv[i + 1];
      if (typeof next === 'string' && !next.startsWith('--')) {
        pluginDataDir = next.trim() ? next : null;
        i += 1;
      } else {
        pluginDataDir = null;
      }
    } else if (arg.startsWith('--plugin-data=')) {
      hasPluginData = true;
      const val = arg.slice('--plugin-data='.length);
      pluginDataDir = val.trim() ? val : null;
    } else if (arg === '--mode') {
      hasMode = true;
      const next = argv[i + 1];
      if (typeof next === 'string' && !next.startsWith('--')) {
        mode = next.trim() ? next.trim() : null;
        i += 1;
      } else {
        mode = null;
      }
    } else if (arg.startsWith('--mode=')) {
      hasMode = true;
      const val = arg.slice('--mode='.length).trim();
      mode = val || null;
    }
  }

  const parsed = { expectedRoot, entryTitle };
  if (hasPluginData) {
    parsed.pluginDataDir = pluginDataDir;
  }
  if (hasMode) {
    parsed.mode = mode;
  }
  return parsed;
}

function resolveCandidatePluginDataDir(pluginDataDir) {
  if (
    typeof pluginDataDir === 'string' &&
    pluginDataDir.trim() &&
    pluginDataDir.trim() !== '${PLUGIN_DATA}'
  ) {
    return pluginDataDir.trim();
  }
  if (typeof process.env.PLUGIN_DATA === 'string' && process.env.PLUGIN_DATA.trim()) {
    return process.env.PLUGIN_DATA.trim();
  }
  return null;
}

export function resolveServerMode({
  pluginDir,
  expectedRoot = null,
  pluginDataDir = null,
  mode = null,
} = {}) {
  const explicitMode = typeof mode === 'string' && mode.trim() ? mode.trim() : null;
  const hasExpectedRoot = typeof expectedRoot === 'string' && expectedRoot.trim().length > 0;
  const isWorkspaceInstall = isInstalledUnderWorkspacePluginsDir(pluginDir);

  if (explicitMode && explicitMode !== 'global' && explicitMode !== 'workspace') {
    return {
      ok: false,
      mode: explicitMode,
      projectRoot: null,
      expectedRoot: expectedRoot || null,
      pluginDir,
      pluginDataDir: null,
      rootError: `不支持的运行模式: "${explicitMode}"（仅支持 workspace 或 global）。`,
    };
  }

  const useWorkspaceMode =
    explicitMode !== 'global' &&
    (explicitMode === 'workspace' || hasExpectedRoot || isWorkspaceInstall);

  if (useWorkspaceMode) {
    try {
      const projectRoot = resolveProjectRootFromPluginDir(pluginDir);
      const boundRoot = validateRootBinding(projectRoot, expectedRoot);
      return {
        ok: true,
        mode: 'workspace',
        projectRoot,
        expectedRoot: boundRoot,
        pluginDir: fs.realpathSync(pluginDir),
        pluginDataDir: null,
        rootError: null,
      };
    } catch (err) {
      return {
        ok: false,
        mode: 'workspace',
        projectRoot: null,
        expectedRoot: expectedRoot || null,
        pluginDir,
        pluginDataDir: null,
        rootError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const dataDir = resolveCandidatePluginDataDir(pluginDataDir);
  if (!dataDir) {
    return {
      ok: false,
      mode: 'global',
      projectRoot: null,
      expectedRoot: null,
      pluginDir,
      pluginDataDir: null,
      rootError: MISSING_PLUGIN_DATA_ERROR,
    };
  }

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.W_OK);
    const realDataDir = fs.realpathSync(dataDir);
    const realPluginDir =
      typeof pluginDir === 'string' && fs.existsSync(pluginDir)
        ? fs.realpathSync(pluginDir)
        : pluginDir;
    return {
      ok: true,
      mode: 'global',
      projectRoot: null,
      expectedRoot: null,
      pluginDir: realPluginDir,
      pluginDataDir: realDataDir,
      rootError: null,
    };
  } catch {
    return {
      ok: false,
      mode: 'global',
      projectRoot: null,
      expectedRoot: null,
      pluginDir,
      pluginDataDir: null,
      rootError: MISSING_PLUGIN_DATA_ERROR,
    };
  }
}

export function resolveRuntimeContext(pluginDir, { expectedRoot, pluginDataDir, mode } = {}) {
  return resolveServerMode({ pluginDir, expectedRoot, pluginDataDir, mode });
}

function summarizeStatusText(snapshot) {
  if (!snapshot.ok && snapshot.rootError) {
    return `Workbench 错误: ${snapshot.rootError}`;
  }
  if (!snapshot.ok && snapshot.error) {
    return `Workbench 错误: ${snapshot.error} | 目录: ${snapshot.projectRoot || '-'}`;
  }
  if (snapshot.mode === 'global' && !snapshot.workspaceBound) {
    const count = Array.isArray(snapshot.trustedWorkspaces) ? snapshot.trustedWorkspaces.length : 0;
    const parts = [
      `Workbench 全局模式: 已注册 ${count} 个受信任工作区`,
      snapshot.bindingError ? `提示: ${snapshot.bindingError}` : '请在侧栏选择或添加受信任工作区',
    ];
    if (snapshot.persistenceError) {
      parts.push(`持久化提示: ${snapshot.persistenceError}`);
    }
    return parts.join(' | ');
  }
  if (!snapshot.configOk) {
    return `Workbench 配置错误: ${snapshot.configError || snapshot.error || 'workbench.json 无效'} | 目录: ${snapshot.projectRoot || '-'}`;
  }

  const counts = snapshot.counts || zeroCounts();
  const parts = [
    `Workbench 状态: 共 ${counts.total} 项 (通过 ${counts.passed} / 失败 ${counts.failed} / 过期 ${counts.stale} / 未运行 ${counts.not_run} / 错误 ${counts.error})`,
    `检查目录: ${snapshot.projectRoot}`,
  ];
  if (snapshot.busy) {
    parts.push('提示: 已有检查正在运行中');
  } else if (snapshot.isRunning) {
    parts.push(
      snapshot.runningBatch
        ? `批量运行中: ${snapshot.runningCheckId || ''}`
        : `正在运行: ${snapshot.runningCheckId || ''}`
    );
  }
  if (snapshot.skippedChecks?.length) {
    parts.push(`已跳过 ${snapshot.skippedChecks.length} 项变更配置`);
  }
  if (snapshot.persistenceError) {
    parts.push(`持久化提示: ${snapshot.persistenceError}`);
  }
  return parts.join(' | ');
}

function summarizeCheckDetailText(snapshot) {
  if (!snapshot.ok) {
    return `Workbench 检查详情错误: ${snapshot.rootError || snapshot.error || snapshot.configError}`;
  }
  const c = snapshot.check;
  if (!c) {
    return 'Workbench 检查详情: 无记录';
  }
  const label = STATE_LABELS[c.effectiveState] || c.effectiveState;
  return `检查项 ${c.id} (${c.name}): ${label}`;
}

export function createWorkbenchServer({
  pluginDir,
  paneHtmlPath,
  expectedRoot = null,
  entryTitle = DEFAULT_ENTRY_TITLE,
  pluginDataDir = null,
  mode = null,
}) {
  const server = new McpServer({
    name: 'workbench',
    version: '0.2.0',
  });

  const runtimeCtx = resolveServerMode({ pluginDir, expectedRoot, pluginDataDir, mode });
  const isGlobalMode = runtimeCtx.mode === 'global';
  const resolvedEntryTitle =
    typeof entryTitle === 'string' && entryTitle.trim() ? entryTitle.trim() : DEFAULT_ENTRY_TITLE;

  const workspaceRunner =
    !isGlobalMode && runtimeCtx.ok
      ? createWorkbenchRunner({ projectRoot: runtimeCtx.projectRoot })
      : null;

  // Stateless per-pane workspace runners in global mode: keyed strictly by trusted workspaceId.
  const runnersByWorkspaceId = new Map();

  const resolvedHtmlPath = () => process.env.WORKBENCH_PANE_HTML || paneHtmlPath;

  registerAppResource(
    server,
    'Workbench Sidebar',
    WORKBENCH_UI_URI,
    {
      description: 'Workbench acceptance check sidebar UI',
      mimeType: RESOURCE_MIME_TYPE,
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    },
    async () => {
      const html = fs.readFileSync(resolvedHtmlPath(), 'utf8');
      return {
        contents: [
          {
            uri: WORKBENCH_UI_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: {
              ui: {
                prefersBorder: false,
              },
            },
          },
        ],
      };
    }
  );

  const buildErrorSnapshot = (extra = {}) => ({
    ok: false,
    mode: runtimeCtx.mode,
    workspaceBound: false,
    configOk: false,
    configError: null,
    projectRoot: null,
    pluginDir: runtimeCtx.pluginDir,
    rootError: runtimeCtx.rootError,
    effectiveState: 'error',
    checks: [],
    counts: zeroCounts(),
    isRunning: false,
    runningCheckId: null,
    runningBatch: false,
    persistenceError: null,
    skippedChecks: [],
    nodeVersion: process.version,
    execPath: process.execPath,
    timestamp: new Date().toISOString(),
    ...(isGlobalMode ? { selectedWorkspace: null, trustedWorkspaces: [] } : {}),
    ...extra,
  });

  const withRuntimeMeta = (payload, extra = {}) => ({
    ...payload,
    mode: runtimeCtx.mode,
    workspaceBound: true,
    pluginDir: runtimeCtx.pluginDir,
    rootError: null,
    nodeVersion: process.version,
    execPath: process.execPath,
    timestamp: new Date().toISOString(),
    ...extra,
  });

  const readGlobalRegistry = () => {
    const reg = readTrustedWorkspaces(runtimeCtx.pluginDataDir);
    return {
      trustedWorkspaces: enrichWorkspaceList(reg.workspaces),
      persistenceError: reg.corrupt ? reg.error : null,
      corrupt: reg.corrupt,
    };
  };

  const getRunnerForWorkspace = (ws) => {
    const cached = runnersByWorkspaceId.get(ws.id);
    if (cached && cached.path === ws.path) {
      return cached.runner;
    }
    const runner = createWorkbenchRunner({ projectRoot: ws.path });
    runnersByWorkspaceId.set(ws.id, { path: ws.path, runner });
    return runner;
  };

  const buildGlobalUnboundSnapshot = ({
    trustedWorkspaces,
    persistenceError = null,
    bindingError = null,
    selectedWorkspace = null,
    projectRoot = null,
    extra = {},
  }) => ({
    ok: true,
    mode: 'global',
    workspaceBound: false,
    configOk: false,
    configError: null,
    projectRoot,
    selectedWorkspace,
    trustedWorkspaces,
    bindingError,
    pluginDir: runtimeCtx.pluginDir,
    rootError: null,
    checks: [],
    counts: zeroCounts(),
    isRunning: false,
    runningCheckId: null,
    runningBatch: false,
    persistenceError,
    skippedChecks: [],
    nodeVersion: process.version,
    execPath: process.execPath,
    timestamp: new Date().toISOString(),
    ...extra,
  });

  const getWorkspaceStatusSnapshot = (extra = {}) => {
    if (!workspaceRunner) {
      return buildErrorSnapshot(extra);
    }
    return withRuntimeMeta(workspaceRunner.getStatus(), extra);
  };

  const hasUiHostCapability = () => isUiCapableClient(server.server.getClientCapabilities());

  const buildUiHostBlockedResult = () => ({
    isError: true,
    content: [{ type: 'text', text: UI_HOST_REQUIRED_ERROR }],
    structuredContent: {
      ok: false,
      blockedByUiHostGate: true,
      mode: runtimeCtx.mode,
      error: UI_HOST_REQUIRED_ERROR,
    },
  });

  registerAppTool(
    server,
    'open_workbench',
    {
      title: resolvedEntryTitle,
      description: 'Open the Workbench acceptance check side panel for this workspace.',
      _meta: {
        ui: {
          resourceUri: WORKBENCH_UI_URI,
        },
        'com.google.antigravity/ui': {
          entrypoints: [
            {
              type: 'aux_pane',
              title: resolvedEntryTitle,
            },
          ],
        },
      },
    },
    async () => {
      if (isGlobalMode) {
        if (!runtimeCtx.ok) {
          const snapshot = buildErrorSnapshot();
          return {
            content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
            structuredContent: snapshot,
          };
        }
        const { trustedWorkspaces, persistenceError } = readGlobalRegistry();
        const snapshot = buildGlobalUnboundSnapshot({ trustedWorkspaces, persistenceError });
        return {
          content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
          structuredContent: snapshot,
        };
      }

      const snapshot = getWorkspaceStatusSnapshot();
      return {
        content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
        structuredContent: snapshot,
      };
    }
  );

  registerAppTool(
    server,
    'workbench_get_status',
    {
      title: 'Workbench Get Status',
      description:
        'Read configured acceptance checks, persisted evidence, and staleness. Omit id for lightweight summary list; pass id for full check output.',
      inputSchema: {
        id: z.string().min(1).optional(),
        workspaceId: z.string().min(1).optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async (args = {}) => {
      if (isGlobalMode) {
        if (!runtimeCtx.ok) {
          const snapshot = buildErrorSnapshot();
          return {
            content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
            structuredContent: snapshot,
          };
        }

        const { trustedWorkspaces, persistenceError } = readGlobalRegistry();
        const workspaceId = args?.workspaceId;

        if (!workspaceId) {
          const snapshot = buildGlobalUnboundSnapshot({ trustedWorkspaces, persistenceError });
          return {
            content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
            structuredContent: snapshot,
          };
        }

        const ws = trustedWorkspaces.find((w) => w.id === workspaceId);
        if (!ws) {
          const snapshot = buildGlobalUnboundSnapshot({
            trustedWorkspaces,
            persistenceError,
            bindingError: UNTRUSTED_WORKSPACE_BINDING_ERROR,
          });
          return {
            content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
            structuredContent: snapshot,
          };
        }

        if (!ws.exists) {
          const missingDirError = `受信任工作区目录不存在或不可访问: "${ws.path}"`;
          if (args?.id) {
            const detail = {
              ok: false,
              mode: 'global',
              workspaceBound: false,
              configOk: false,
              configError: null,
              error: missingDirError,
              bindingError: missingDirError,
              projectRoot: ws.path,
              selectedWorkspace: ws,
              trustedWorkspaces,
              check: null,
              isRunning: false,
              runningCheckId: null,
              runningBatch: false,
              persistenceError,
              skippedChecks: [],
              pluginDir: runtimeCtx.pluginDir,
              rootError: null,
              nodeVersion: process.version,
              execPath: process.execPath,
              timestamp: new Date().toISOString(),
            };
            return {
              content: [{ type: 'text', text: summarizeCheckDetailText(detail) }],
              structuredContent: detail,
            };
          }
          const snapshot = buildGlobalUnboundSnapshot({
            trustedWorkspaces,
            persistenceError,
            bindingError: missingDirError,
            selectedWorkspace: ws,
            projectRoot: ws.path,
          });
          return {
            content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
            structuredContent: snapshot,
          };
        }

        const runner = getRunnerForWorkspace(ws);
        if (args?.id) {
          const detail = withRuntimeMeta(runner.getStatus({ id: args.id }), {
            mode: 'global',
            workspaceBound: true,
            selectedWorkspace: ws,
            trustedWorkspaces,
            bindingError: null,
          });
          return {
            content: [{ type: 'text', text: summarizeCheckDetailText(detail) }],
            structuredContent: detail,
          };
        }

        const snapshot = withRuntimeMeta(runner.getStatus(), {
          mode: 'global',
          workspaceBound: true,
          selectedWorkspace: ws,
          trustedWorkspaces,
          bindingError: null,
        });
        return {
          content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
          structuredContent: snapshot,
        };
      }

      if (!workspaceRunner) {
        const snapshot = buildErrorSnapshot();
        return {
          content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
          structuredContent: snapshot,
        };
      }

      if (args?.id) {
        const detail = withRuntimeMeta(workspaceRunner.getStatus({ id: args.id }));
        return {
          content: [{ type: 'text', text: summarizeCheckDetailText(detail) }],
          structuredContent: detail,
        };
      }

      const snapshot = getWorkspaceStatusSnapshot();
      return {
        content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
        structuredContent: snapshot,
      };
    }
  );

  const resolveGlobalExecutionRunner = (workspaceId) => {
    const { trustedWorkspaces, persistenceError } = readGlobalRegistry();
    const ws = workspaceId ? trustedWorkspaces.find((w) => w.id === workspaceId) : null;
    if (!workspaceId || !ws) {
      return {
        ok: false,
        snapshot: {
          ...buildGlobalUnboundSnapshot({
            trustedWorkspaces,
            persistenceError,
            bindingError: UNBOUND_EXECUTION_ERROR,
          }),
          ok: false,
          busy: false,
          error: UNBOUND_EXECUTION_ERROR,
        },
      };
    }
    if (!ws.exists) {
      const missingDirError = `受信任工作区目录不存在或不可访问: "${ws.path}"`;
      return {
        ok: false,
        snapshot: {
          ...buildGlobalUnboundSnapshot({
            trustedWorkspaces,
            persistenceError,
            bindingError: missingDirError,
            selectedWorkspace: ws,
            projectRoot: ws.path,
          }),
          ok: false,
          busy: false,
          error: missingDirError,
        },
      };
    }
    return {
      ok: true,
      ws,
      trustedWorkspaces,
      runner: getRunnerForWorkspace(ws),
    };
  };

  registerAppTool(
    server,
    'workbench_run_check',
    {
      title: 'Workbench Run Check',
      description: 'Run a single configured acceptance check by id and persist evidence.',
      inputSchema: {
        id: z.string().min(1),
        workspaceId: z.string().min(1).optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ id, workspaceId }) => {
      if (!hasUiHostCapability()) {
        return buildUiHostBlockedResult();
      }
      if (isGlobalMode) {
        if (!runtimeCtx.ok) {
          const snapshot = buildErrorSnapshot({ busy: false });
          return {
            content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
            structuredContent: snapshot,
          };
        }
        const resolved = resolveGlobalExecutionRunner(workspaceId);
        if (!resolved.ok) {
          return {
            content: [{ type: 'text', text: summarizeStatusText(resolved.snapshot) }],
            structuredContent: resolved.snapshot,
          };
        }
        const runResult = await resolved.runner.runCheck(id);
        const { trustedWorkspaces } = readGlobalRegistry();
        const snapshot = withRuntimeMeta(runResult, {
          mode: 'global',
          workspaceBound: true,
          selectedWorkspace: resolved.ws,
          trustedWorkspaces,
          bindingError: null,
        });
        return {
          content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
          structuredContent: snapshot,
        };
      }

      if (!workspaceRunner) {
        const snapshot = buildErrorSnapshot({ busy: false });
        return {
          content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
          structuredContent: snapshot,
        };
      }
      const runResult = await workspaceRunner.runCheck(id);
      const snapshot = withRuntimeMeta(runResult);
      return {
        content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
        structuredContent: snapshot,
      };
    }
  );

  registerAppTool(
    server,
    'workbench_run_all',
    {
      title: 'Workbench Run All',
      description: 'Run all configured acceptance checks sequentially in config order.',
      inputSchema: {
        workspaceId: z.string().min(1).optional(),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async (args = {}) => {
      if (!hasUiHostCapability()) {
        return buildUiHostBlockedResult();
      }
      if (isGlobalMode) {
        if (!runtimeCtx.ok) {
          const snapshot = buildErrorSnapshot({ busy: false });
          return {
            content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
            structuredContent: snapshot,
          };
        }
        const resolved = resolveGlobalExecutionRunner(args?.workspaceId);
        if (!resolved.ok) {
          return {
            content: [{ type: 'text', text: summarizeStatusText(resolved.snapshot) }],
            structuredContent: resolved.snapshot,
          };
        }
        const runResult = await resolved.runner.runAll();
        const { trustedWorkspaces } = readGlobalRegistry();
        const snapshot = withRuntimeMeta(runResult, {
          mode: 'global',
          workspaceBound: true,
          selectedWorkspace: resolved.ws,
          trustedWorkspaces,
          bindingError: null,
        });
        return {
          content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
          structuredContent: snapshot,
        };
      }

      if (!workspaceRunner) {
        const snapshot = buildErrorSnapshot({ busy: false });
        return {
          content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
          structuredContent: snapshot,
        };
      }
      const runResult = await workspaceRunner.runAll();
      const snapshot = withRuntimeMeta(runResult);
      return {
        content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
        structuredContent: snapshot,
      };
    }
  );

  registerAppTool(
    server,
    'workbench_add_trusted_workspace',
    {
      title: 'Workbench Add Trusted Workspace',
      description: 'Register a local workspace directory as trusted in global Workbench mode.',
      inputSchema: {
        workspacePath: z.string().min(1),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ workspacePath }) => {
      if (!hasUiHostCapability()) {
        return buildUiHostBlockedResult();
      }
      if (!isGlobalMode) {
        const payload = {
          ok: false,
          mode: runtimeCtx.mode,
          workspaceBound: runtimeCtx.ok,
          error: WORKSPACE_MODE_ADD_ERROR,
          pluginDir: runtimeCtx.pluginDir,
          timestamp: new Date().toISOString(),
        };
        return {
          content: [{ type: 'text', text: `Workbench 错误: ${payload.error}` }],
          structuredContent: payload,
        };
      }

      if (!runtimeCtx.ok) {
        const payload = buildErrorSnapshot({ error: runtimeCtx.rootError, addedWorkspace: null });
        return {
          content: [{ type: 'text', text: summarizeStatusText(payload) }],
          structuredContent: payload,
        };
      }

      try {
        const { workspace, workspaces } = addTrustedWorkspace(
          runtimeCtx.pluginDataDir,
          workspacePath
        );
        const trustedWorkspaces = enrichWorkspaceList(workspaces);
        const addedWorkspace =
          trustedWorkspaces.find((w) => w.id === workspace.id) ||
          enrichWorkspaceList([workspace])[0];
        const payload = {
          ok: true,
          mode: 'global',
          addedWorkspace,
          trustedWorkspaces,
          pluginDir: runtimeCtx.pluginDir,
          rootError: null,
          timestamp: new Date().toISOString(),
        };
        return {
          content: [
            {
              type: 'text',
              text: `已添加受信任工作区: ${addedWorkspace.label} (${addedWorkspace.id})`,
            },
          ],
          structuredContent: payload,
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const { trustedWorkspaces } = readGlobalRegistry();
        const payload = {
          ok: false,
          mode: 'global',
          error: errorMessage,
          addedWorkspace: null,
          trustedWorkspaces,
          pluginDir: runtimeCtx.pluginDir,
          rootError: null,
          timestamp: new Date().toISOString(),
        };
        return {
          content: [{ type: 'text', text: `添加受信任工作区失败: ${errorMessage}` }],
          structuredContent: payload,
        };
      }
    }
  );

  registerAppTool(
    server,
    'workbench_remove_trusted_workspace',
    {
      title: 'Workbench Remove Trusted Workspace',
      description: 'Remove a workspace from the trusted workspaces registry in global mode.',
      inputSchema: {
        workspaceId: z.string().min(1),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ workspaceId }) => {
      if (!hasUiHostCapability()) {
        return buildUiHostBlockedResult();
      }
      if (!isGlobalMode) {
        const payload = {
          ok: false,
          mode: runtimeCtx.mode,
          workspaceBound: runtimeCtx.ok,
          busy: false,
          removed: false,
          error: WORKSPACE_MODE_REMOVE_ERROR,
          pluginDir: runtimeCtx.pluginDir,
          timestamp: new Date().toISOString(),
        };
        return {
          content: [{ type: 'text', text: `Workbench 错误: ${payload.error}` }],
          structuredContent: payload,
        };
      }

      if (!runtimeCtx.ok) {
        const payload = buildErrorSnapshot({
          busy: false,
          removed: false,
          error: runtimeCtx.rootError,
        });
        return {
          content: [{ type: 'text', text: summarizeStatusText(payload) }],
          structuredContent: payload,
        };
      }

      const cached = runnersByWorkspaceId.get(workspaceId);
      if (cached && cached.runner.isBusy()) {
        const { trustedWorkspaces } = readGlobalRegistry();
        const payload = {
          ok: false,
          mode: 'global',
          busy: true,
          removed: false,
          error: BUSY_REMOVE_WORKSPACE_ERROR,
          trustedWorkspaces,
          pluginDir: runtimeCtx.pluginDir,
          rootError: null,
          timestamp: new Date().toISOString(),
        };
        return {
          content: [{ type: 'text', text: `移除受信任工作区失败: ${BUSY_REMOVE_WORKSPACE_ERROR}` }],
          structuredContent: payload,
        };
      }

      try {
        const { removed, workspaces } = removeTrustedWorkspace(
          runtimeCtx.pluginDataDir,
          workspaceId
        );
        runnersByWorkspaceId.delete(workspaceId);
        const trustedWorkspaces = enrichWorkspaceList(workspaces);
        const payload = {
          ok: true,
          mode: 'global',
          busy: false,
          removed,
          trustedWorkspaces,
          pluginDir: runtimeCtx.pluginDir,
          rootError: null,
          timestamp: new Date().toISOString(),
        };
        return {
          content: [
            {
              type: 'text',
              text: removed
                ? `已移除受信任工作区: ${workspaceId}`
                : `未找到受信任工作区: ${workspaceId}`,
            },
          ],
          structuredContent: payload,
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const payload = {
          ok: false,
          mode: 'global',
          busy: false,
          removed: false,
          error: errorMessage,
          trustedWorkspaces: [],
          pluginDir: runtimeCtx.pluginDir,
          rootError: null,
          timestamp: new Date().toISOString(),
        };
        return {
          content: [{ type: 'text', text: `移除受信任工作区失败: ${errorMessage}` }],
          structuredContent: payload,
        };
      }
    }
  );

  registerAppTool(
    server,
    'workbench_ping',
    {
      title: 'Workbench Ping',
      description: 'Verify sidebar-to-server round-trip connectivity and runtime details.',
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async () => {
      const uiHostCapable = hasUiHostCapability();
      if (isGlobalMode) {
        if (!runtimeCtx.ok) {
          const payload = buildErrorSnapshot({ pong: 'workbench-ok', uiHostCapable });
          return {
            content: [{ type: 'text', text: `pong error: ${payload.rootError}` }],
            structuredContent: payload,
          };
        }
        const { trustedWorkspaces, persistenceError } = readGlobalRegistry();
        const payload = buildGlobalUnboundSnapshot({
          trustedWorkspaces,
          persistenceError,
          extra: { pong: 'workbench-ok', uiHostCapable },
        });
        return {
          content: [
            {
              type: 'text',
              text: `pong: ${payload.pong} | mode: global | node: ${payload.nodeVersion}`,
            },
          ],
          structuredContent: payload,
        };
      }

      const payload = getWorkspaceStatusSnapshot({ pong: 'workbench-ok', uiHostCapable });
      const text = payload.ok
        ? `pong: ${payload.pong} | root: ${payload.projectRoot} | node: ${payload.nodeVersion}`
        : `pong error: ${payload.rootError}`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: payload,
      };
    }
  );

  return server;
}

async function main() {
  const serverDir =
    typeof __dirname === 'string'
      ? __dirname
      : path.dirname(path.resolve(process.argv[1]));
  const pluginDir = path.resolve(serverDir, '..');
  const paneHtmlPath = path.join(serverDir, 'pane.html');
  const {
    expectedRoot,
    entryTitle,
    pluginDataDir = null,
    mode = null,
  } = parseServerArgs(process.argv.slice(2));

  const server = createWorkbenchServer({
    pluginDir,
    paneHtmlPath,
    expectedRoot,
    entryTitle,
    pluginDataDir,
    mode,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[workbench] MCP server started (pluginDir=${pluginDir}, expectedRoot=${expectedRoot || 'UNBOUND'}, pluginDataDir=${pluginDataDir || process.env.PLUGIN_DATA || 'UNSET'}, mode=${mode || 'auto'}, entryTitle=${entryTitle}, node=${process.version})\n`
  );
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[workbench] Fatal startup error: ${err?.stack || err}\n`);
    process.exit(1);
  });
}
