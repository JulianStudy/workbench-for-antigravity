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

export function createWorkbenchServer({ pluginDir, paneHtmlPath }) {
  const server = new McpServer({
    name: 'workbench',
    version: '0.1.0',
  });

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

  const buildSnapshot = (extra = {}) => {
    const ctx = resolveRuntimeContext(pluginDir);
    return {
      ok: ctx.ok,
      projectRoot: ctx.projectRoot,
      pluginDir: ctx.pluginDir,
      rootError: ctx.rootError,
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
      const snapshot = buildSnapshot({ phase: 1 });
      const text = snapshot.ok
        ? `Workbench connected. Project root: ${snapshot.projectRoot} (Node ${snapshot.nodeVersion})`
        : `Workbench root error: ${snapshot.rootError}`;
      return {
        content: [{ type: 'text', text }],
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
      const payload = buildSnapshot({
        pong: 'workbench-ok',
      });
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

// Only auto-start when executed directly (CJS bundle entrypoint).
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[workbench] Fatal startup error: ${err?.stack || err}\n`);
    process.exit(1);
  });
}
