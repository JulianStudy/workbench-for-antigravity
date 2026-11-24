import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pkgRoot, '../..');

const srcDir = path.join(pkgRoot, 'src');
const distPluginDir = path.join(repoRoot, 'dist', 'workbench');
const demoPluginDir = path.join(repoRoot, 'work', 'workbench-demo', '.agents', 'plugins', 'workbench');

async function buildUiHtml() {
  const uiBundle = await esbuild.build({
    entryPoints: [path.join(srcDir, 'ui', 'pane.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    write: false,
    minify: false,
    logLevel: 'silent',
  });

  if (!uiBundle.outputFiles || uiBundle.outputFiles.length === 0) {
    throw new Error('esbuild produced no output for src/ui/pane.js');
  }

  const rawJs = uiBundle.outputFiles[0].text;
  const safeInlineJs = rawJs.replace(/<\/script>/gi, '<\\/script>');
  const templateHtml = fs.readFileSync(path.join(srcDir, 'ui', 'pane.html'), 'utf8');

  const marker = '<!-- WORKBENCH_INLINE_SCRIPT -->';
  if (!templateHtml.includes(marker)) {
    throw new Error(`Missing ${marker} placeholder in src/ui/pane.html`);
  }

  return templateHtml.replace(marker, () => `<script>\n${safeInlineJs}\n</script>`);
}

async function buildServerBundle(outfile) {
  await esbuild.build({
    entryPoints: [path.join(srcDir, 'server.mjs')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node22'],
    outfile,
    logLevel: 'silent',
  });
}

function copyDirClean(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

async function main() {
  fs.rmSync(distPluginDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(distPluginDir, 'dist'), { recursive: true });

  const paneHtml = await buildUiHtml();
  fs.writeFileSync(path.join(distPluginDir, 'dist', 'pane.html'), paneHtml, 'utf8');

  await buildServerBundle(path.join(distPluginDir, 'dist', 'server.cjs'));

  for (const manifestFile of ['plugin.json', 'mcp_config.json']) {
    fs.copyFileSync(path.join(pkgRoot, manifestFile), path.join(distPluginDir, manifestFile));
  }

  const readmeSrc = path.join(pkgRoot, 'README.md');
  if (fs.existsSync(readmeSrc)) {
    fs.copyFileSync(readmeSrc, path.join(distPluginDir, 'README.md'));
  }

  if (fs.existsSync(path.join(repoRoot, 'work', 'workbench-demo'))) {
    copyDirClean(distPluginDir, demoPluginDir);
  }

  process.stderr.write(
    `[workbench build] Built plugin bundle -> ${distPluginDir}\n` +
      `[workbench build] Synced demo plugin -> ${demoPluginDir}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`[workbench build] FAILED: ${err?.stack || err}\n`);
  process.exit(1);
});
