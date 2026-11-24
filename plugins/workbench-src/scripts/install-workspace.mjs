import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pkgRoot, '../..');

export const DEFAULT_DIST_PLUGIN_DIR = path.join(repoRoot, 'dist', 'workbench');
const WORKBENCH_SCOPED_RE = /^workbench-[0-9a-f]{12}$/;

/**
 * Compute deterministic workspace-scoped plugin identity from a workspace directory path.
 */
export function computeWorkspaceIdentity(workspacePath) {
  if (!workspacePath || typeof workspacePath !== 'string' || !workspacePath.trim()) {
    throw new Error('Workspace path is required.');
  }

  let realRoot;
  try {
    realRoot = fs.realpathSync(workspacePath);
  } catch (err) {
    throw new Error(
      `Workspace path does not exist or cannot be resolved: ${workspacePath} (${err instanceof Error ? err.message : String(err)})`
    );
  }

  const stat = fs.statSync(realRoot);
  if (!stat.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${realRoot}`);
  }

  const hash = crypto.createHash('sha256').update(realRoot, 'utf8').digest('hex').slice(0, 12);
  const pluginName = `workbench-${hash}`;
  const workspaceLabel = path.basename(realRoot) || realRoot;
  const entryTitle = `Workbench (${workspaceLabel} · ${hash.slice(0, 4)})`;
  const installDir = path.join(realRoot, '.agents', 'plugins', pluginName);

  return {
    realRoot,
    hash,
    pluginName,
    displayName: entryTitle,
    entryTitle,
    installDir,
  };
}

/**
 * Find any conflicting Workbench plugin entries under `<realRoot>/.agents/plugins/`.
 * Conflicts are exact name `workbench` or any `workbench-<12hex>` other than `expectedPluginName`.
 */
export function findConflictingWorkbenchDirs(realRoot, expectedPluginName) {
  const pluginsDir = path.join(realRoot, '.agents', 'plugins');
  if (!fs.existsSync(pluginsDir)) {
    return [];
  }

  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  const conflicts = [];
  for (const entry of entries) {
    const isLegacy = entry.name === 'workbench';
    const isOtherScoped =
      WORKBENCH_SCOPED_RE.test(entry.name) && entry.name !== expectedPluginName;
    if (isLegacy || isOtherScoped) {
      conflicts.push(path.join(pluginsDir, entry.name));
    }
  }
  return conflicts.sort();
}

function assertValidDistBundle(distPluginDir) {
  const requiredPaths = [
    path.join(distPluginDir, 'plugin.json'),
    path.join(distPluginDir, 'mcp_config.json'),
    path.join(distPluginDir, 'dist', 'server.cjs'),
    path.join(distPluginDir, 'dist', 'pane.html'),
  ];
  for (const required of requiredPaths) {
    if (!fs.existsSync(required)) {
      throw new Error(
        `Built plugin bundle is incomplete (missing ${required}). Run "npm run build" in plugins/workbench-src first.`
      );
    }
  }
}

/**
 * Install the built Workbench plugin into `<workspace>/.agents/plugins/workbench-<hash12>/`
 * with workspace-bound identity, displayName, and MCP startup arguments.
 */
export function installWorkspacePlugin(
  targetPath,
  { distPluginDir = DEFAULT_DIST_PLUGIN_DIR } = {}
) {
  const identity = computeWorkspaceIdentity(targetPath);

  const conflicts = findConflictingWorkbenchDirs(identity.realRoot, identity.pluginName);
  if (conflicts.length > 0) {
    const conflictList = conflicts.map((p) => `  - ${p}`).join('\n');
    throw new Error(
      `Found conflicting Workbench installation(s) under .agents/plugins/:\n${conflictList}\n` +
        `Please move or remove the old Workbench installation(s) out of .agents/plugins/ before retrying.`
    );
  }

  assertValidDistBundle(distPluginDir);

  const pluginsDir = path.join(identity.realRoot, '.agents', 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  fs.rmSync(identity.installDir, { recursive: true, force: true });
  fs.cpSync(distPluginDir, identity.installDir, { recursive: true });

  const templatePluginJson = JSON.parse(
    fs.readFileSync(path.join(distPluginDir, 'plugin.json'), 'utf8')
  );
  const generatedPluginJson = {
    ...templatePluginJson,
    name: identity.pluginName,
    displayName: identity.displayName,
  };
  fs.writeFileSync(
    path.join(identity.installDir, 'plugin.json'),
    `${JSON.stringify(generatedPluginJson, null, 2)}\n`,
    'utf8'
  );

  const templateMcpConfig = JSON.parse(
    fs.readFileSync(path.join(distPluginDir, 'mcp_config.json'), 'utf8')
  );
  const generatedMcpConfig = {
    ...templateMcpConfig,
    mcpServers: {
      ...(templateMcpConfig.mcpServers || {}),
      workbench_runner: {
        ...(templateMcpConfig.mcpServers?.workbench_runner || {}),
        command: 'node',
        args: [
          '${PLUGIN_ROOT}/dist/server.cjs',
          '--expected-root',
          identity.realRoot,
          '--entry-title',
          identity.entryTitle,
        ],
      },
    },
  };
  fs.writeFileSync(
    path.join(identity.installDir, 'mcp_config.json'),
    `${JSON.stringify(generatedMcpConfig, null, 2)}\n`,
    'utf8'
  );

  return {
    ...identity,
    pluginJson: generatedPluginJson,
    mcpConfig: generatedMcpConfig,
  };
}

function isDirectCliInvocation() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(__filename);
  } catch {
    return path.resolve(process.argv[1]) === __filename;
  }
}

if (isDirectCliInvocation()) {
  const targetArg = process.argv[2];
  if (!targetArg) {
    process.stderr.write(
      'Usage: node scripts/install-workspace.mjs <workspace-dir>\n'
    );
    process.exit(1);
  }

  try {
    const result = installWorkspacePlugin(targetArg);
    process.stdout.write(`${result.installDir}\n`);
  } catch (err) {
    process.stderr.write(
      `[workbench install] FAILED: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }
}
