import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { resolveProjectRootFromPluginDir } from './root.mjs';
import { ACCEPTANCE_CRITERION, createCheckRunner } from './check.mjs';

export const WORKBENCH_UI_URI = 'ui://workbench/pane.html';

export function resolveRuntimeContext(pluginDir) {
  try {
    const projectRoot = resolveProjectRootFromPluginDir(pluginDir);
    return {
      ok: true,
      projectRoot,
      pluginDir: fs.realpathSync(pluginDir),
      rootError: null,
    };
  } catch (err) {
    return {
      ok: false,
      projectRoot: null,
      pluginDir,
      rootError: err instanceof Error ? err.message : String(err),
    };
  }
}

function summarizeStatusText(snapshot) {
  if (!snapshot.ok) {
    return `Workbench 错误: ${snapshot.rootError}`;
  }
  const stateMap = {
    not_run: '未运行',
    passed: '通过',
    failed: '失败',
    stale: '已过期',
    error: '执行错误',
  };
  const label = stateMap[snapshot.effectiveState] || snapshot.effectiveState;
  const parts = [
    `Workbench 状态: ${label}`,
    `检查目录: ${snapshot.projectRoot}`,
    `验收条件: ${snapshot.criterion}`,
  ];
  if (snapshot.busy) {
    parts.push('提示: 已有检查正在运行中');
  }
  if (snapshot.changedFiles?.length) {
    parts.push(`变动文件: ${snapshot.changedFiles.join(', ')}`);
  }
  if (snapshot.lastRun) {
    parts.push(`上次结果: ${stateMap[snapshot.lastRun.status] || snapshot.lastRun.status} (退出码 ${snapshot.lastRun.exitCode ?? '无'})`);
  }
  if (snapshot.persistenceError) {
    parts.push(`持久化提示: ${snapshot.persistenceError}`);
  }
  return parts.join(' | ');
}

export function createWorkbenchServer({ pluginDir, paneHtmlPath }) {
  const server = new McpServer({
    name: 'workbench',
    version: '0.1.0',
  });

  const runtimeCtx = resolveRuntimeContext(pluginDir);
  const runner = runtimeCtx.ok
    ? createCheckRunner({ projectRoot: runtimeCtx.projectRoot })
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
    projectRoot: null,
    pluginDir: runtimeCtx.pluginDir,
    rootError: runtimeCtx.rootError,
    criterion: ACCEPTANCE_CRITERION,
    effectiveState: 'error',
    isRunning: false,
    isValid: false,
    staleReason: null,
    changedFiles: [],
    lastRun: null,
    persistenceError: null,
    nodeVersion: process.version,
    execPath: process.execPath,
    timestamp: new Date().toISOString(),
    ...extra,
  });

  const getStatusSnapshot = (extra = {}) => {
    if (!runner) {
      return buildErrorSnapshot(extra);
    }
    return {
      ...runner.getStatus(),
      pluginDir: runtimeCtx.pluginDir,
      rootError: null,
      nodeVersion: process.version,
      execPath: process.execPath,
      timestamp: new Date().toISOString(),
      ...extra,
    };
  };

  registerAppTool(
    server,
    'open_workbench',
    {
      title: 'Workbench',
      description: 'Open the Workbench acceptance check side panel for this workspace.',
      _meta: {
        ui: {
          resourceUri: WORKBENCH_UI_URI,
        },
        'com.google.antigravity/ui': {
          entrypoints: [
            {
              type: 'aux_pane',
              title: 'Workbench',
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
      description: 'Read persisted last-run evidence and evaluate current staleness.',
      _meta: {
        ui: {
          visibility: ['app'],
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
    'workbench_run_check',
    {
      title: 'Workbench Run Check',
      description: 'Run the fixed acceptance check in the project root and persist evidence.',
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
      const runResult = await runner.runCheck();
      const snapshot = {
        ...runResult,
        pluginDir: runtimeCtx.pluginDir,
        rootError: null,
        nodeVersion: process.version,
        execPath: process.execPath,
        timestamp: new Date().toISOString(),
      };
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

  const server = createWorkbenchServer({ pluginDir, paneHtmlPath });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[workbench] MCP server started (pluginDir=${pluginDir}, node=${process.version})\n`);
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[workbench] Fatal startup error: ${err?.stack || err}\n`);
    process.exit(1);
  });
}
