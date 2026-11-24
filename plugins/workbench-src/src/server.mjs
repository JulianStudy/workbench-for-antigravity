import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { resolveProjectRootFromPluginDir, validateRootBinding } from './root.mjs';
import { createWorkbenchRunner } from './check.mjs';

export const WORKBENCH_UI_URI = 'ui://workbench/pane.html';
export const DEFAULT_ENTRY_TITLE = 'Workbench';

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
    }
  }

  return { expectedRoot, entryTitle };
}

export function resolveRuntimeContext(pluginDir, { expectedRoot } = {}) {
  try {
    const projectRoot = resolveProjectRootFromPluginDir(pluginDir);
    const boundRoot = validateRootBinding(projectRoot, expectedRoot);
    return {
      ok: true,
      projectRoot,
      expectedRoot: boundRoot,
      pluginDir: fs.realpathSync(pluginDir),
      rootError: null,
    };
  } catch (err) {
    return {
      ok: false,
      projectRoot: null,
      expectedRoot: expectedRoot || null,
      pluginDir,
      rootError: err instanceof Error ? err.message : String(err),
    };
  }
}

function summarizeStatusText(snapshot) {
  if (!snapshot.ok && snapshot.rootError) {
    return `Workbench 错误: ${snapshot.rootError}`;
  }
  if (!snapshot.configOk) {
    return `Workbench 配置错误: ${snapshot.configError || snapshot.error || 'workbench.json 无效'} | 目录: ${snapshot.projectRoot || '-'}`;
  }
  if (!snapshot.ok && snapshot.error) {
    return `Workbench 错误: ${snapshot.error} | 目录: ${snapshot.projectRoot || '-'}`;
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
}) {
  const server = new McpServer({
    name: 'workbench',
    version: '0.1.0',
  });

  const runtimeCtx = resolveRuntimeContext(pluginDir, { expectedRoot });
  const resolvedEntryTitle =
    typeof entryTitle === 'string' && entryTitle.trim() ? entryTitle.trim() : DEFAULT_ENTRY_TITLE;
  const runner = runtimeCtx.ok
    ? createWorkbenchRunner({ projectRoot: runtimeCtx.projectRoot })
    : null;

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
    ...extra,
  });

  const withRuntimeMeta = (payload, extra = {}) => ({
    ...payload,
    pluginDir: runtimeCtx.pluginDir,
    rootError: null,
    nodeVersion: process.version,
    execPath: process.execPath,
    timestamp: new Date().toISOString(),
    ...extra,
  });

  const getStatusSnapshot = (extra = {}) => {
    if (!runner) {
      return buildErrorSnapshot(extra);
    }
    return withRuntimeMeta(runner.getStatus(), extra);
  };

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
      const snapshot = getStatusSnapshot();
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
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async (args = {}) => {
      if (!runner) {
        const snapshot = buildErrorSnapshot();
        return {
          content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
          structuredContent: snapshot,
        };
      }

      if (args?.id) {
        const detail = withRuntimeMeta(runner.getStatus({ id: args.id }));
        return {
          content: [{ type: 'text', text: summarizeCheckDetailText(detail) }],
          structuredContent: detail,
        };
      }

      const snapshot = getStatusSnapshot();
      return {
        content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
        structuredContent: snapshot,
      };
    }
  );

  registerAppTool(
    server,
    'workbench_run_check',
    {
      title: 'Workbench Run Check',
      description: 'Run a single configured acceptance check by id and persist evidence.',
      inputSchema: {
        id: z.string().min(1),
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async ({ id }) => {
      if (!runner) {
        const snapshot = buildErrorSnapshot({ busy: false });
        return {
          content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
          structuredContent: snapshot,
        };
      }
      const runResult = await runner.runCheck(id);
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
      inputSchema: {},
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async () => {
      if (!runner) {
        const snapshot = buildErrorSnapshot({ busy: false });
        return {
          content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
          structuredContent: snapshot,
        };
      }
      const runResult = await runner.runAll();
      const snapshot = withRuntimeMeta(runResult);
      return {
        content: [{ type: 'text', text: summarizeStatusText(snapshot) }],
        structuredContent: snapshot,
      };
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
      const payload = getStatusSnapshot({ pong: 'workbench-ok' });
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
  const { expectedRoot, entryTitle } = parseServerArgs(process.argv.slice(2));

  const server = createWorkbenchServer({
    pluginDir,
    paneHtmlPath,
    expectedRoot,
    entryTitle,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[workbench] MCP server started (pluginDir=${pluginDir}, expectedRoot=${expectedRoot || 'UNBOUND'}, entryTitle=${entryTitle}, node=${process.version})\n`
  );
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[workbench] Fatal startup error: ${err?.stack || err}\n`);
    process.exit(1);
  });
}
