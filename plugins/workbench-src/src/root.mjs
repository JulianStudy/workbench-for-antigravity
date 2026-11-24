import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve workspace project root from an installed workspace plugin directory.
 * Strictly requires the plugin to live under `<projectRoot>/.agents/plugins/<pluginDir>`.
 */
export function resolveProjectRootFromPluginDir(pluginDir) {
  if (!pluginDir || typeof pluginDir !== 'string') {
    throw new Error('Invalid plugin directory path.');
  }

  const realPluginDir = fs.realpathSync(pluginDir);
  const pluginsParent = path.dirname(realPluginDir);
  const agentsDir = path.dirname(pluginsParent);
  const projectRoot = path.dirname(agentsDir);

  if (
    path.basename(pluginsParent) !== 'plugins' ||
    path.basename(agentsDir) !== '.agents' ||
    !projectRoot ||
    projectRoot === agentsDir
  ) {
    throw new Error(
      `Workbench plugin must be installed under "<projectRoot>/.agents/plugins/<name>". Resolved plugin path: ${realPluginDir}`
    );
  }

  const stat = fs.statSync(projectRoot);
  if (!stat.isDirectory()) {
    throw new Error(`Resolved project root is not a directory: ${projectRoot}`);
  }

  return projectRoot;
}
