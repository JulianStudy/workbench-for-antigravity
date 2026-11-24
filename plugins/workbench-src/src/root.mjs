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

/**
 * Validate that the resolved project root matches the bound `--expected-root` workspace path.
 */
export function validateRootBinding(projectRoot, expectedRoot) {
  if (!expectedRoot || typeof expectedRoot !== 'string' || !expectedRoot.trim()) {
    throw new Error(
      '缺少工作区绑定参数（--expected-root）。请通过 install-workspace.mjs 为当前工作区生成独立安装。'
    );
  }

  let realExpectedRoot;
  try {
    realExpectedRoot = fs.realpathSync(expectedRoot);
  } catch {
    throw new Error(
      `工作区绑定不匹配：当前插件绑定的工作区不存在或不可访问（"${expectedRoot}"），不能在 "${projectRoot}" 中运行。复制已安装目录到另一项目后，必须用安装脚本在目标项目生成自己的身份。`
    );
  }

  if (realExpectedRoot !== projectRoot) {
    throw new Error(
      `工作区绑定不匹配：当前插件绑定于 "${realExpectedRoot}"，不能在 "${projectRoot}" 中运行。复制已安装目录到另一项目后，必须用安装脚本在目标项目生成自己的身份。`
    );
  }

  return realExpectedRoot;
}
