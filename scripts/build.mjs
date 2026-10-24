// 构建脚本：每个入口单独打包成自包含的 IIFE，内容脚本因此不依赖任何运行时 chunk。
import esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');
const watch = process.argv.includes('--watch');

/** 入口清单：输出文件名 -> 源文件。全部产出 IIFE 自包含包。 */
const ENTRIES = [
  { out: 'background.js', in: 'src/background/index.ts' },
  { out: 'content.js', in: 'src/content/index.ts' },
  { out: 'popup.js', in: 'src/popup/index.tsx' },
  { out: 'options.js', in: 'src/options/index.tsx' },
  { out: 'offscreen.js', in: 'src/offscreen/index.ts' },
];

/** 直接复制的静态资源。 */
const STATIC = [
  ['src/popup/popup.html', 'popup.html'],
  ['src/options/options.html', 'options.html'],
  ['src/offscreen/offscreen.html', 'offscreen.html'],
  ['src/ui/tokens.css', 'tokens.css'],
  ['src/ui/controls.css', 'controls.css'],
  ['src/ui/components.css', 'components.css'],
  ['src/icons', 'icons'],
];

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

function baseOptions(entry) {
  return {
    absWorkingDir: ROOT,
    entryPoints: [entry.in],
    outfile: resolve(DIST, entry.out),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome116'],
    jsx: 'automatic',
    jsxImportSource: 'preact',
    // 内容脚本把样式表当字符串内联进 Shadow DOM，因此 CSS 一律按文本加载
    loader: { '.css': 'text' },
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    legalComments: 'none',
    logLevel: 'silent',
    metafile: true,
    define: {
      'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'),
      __DEV__: JSON.stringify(watch),
    },
  };
}

function copyStatic() {
  for (const [from, to] of STATIC) {
    cpSync(resolve(ROOT, from), resolve(DIST, to), { recursive: true });
  }
}

function writeManifest() {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'src/manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  writeFileSync(resolve(DIST, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** 校验 manifest 里引用的每个文件都真实存在，避免加载时才报错。 */
function verifyManifest(manifest) {
  const referenced = new Set();
  const add = (p) => p && referenced.add(p);

  for (const icon of Object.values(manifest.icons ?? {})) add(icon);
  for (const icon of Object.values(manifest.action?.default_icon ?? {})) add(icon);
  add(manifest.action?.default_popup);
  add(manifest.options_page);
  add(manifest.background?.service_worker);
  for (const group of manifest.content_scripts ?? []) {
    for (const f of group.js ?? []) add(f);
    for (const f of group.css ?? []) add(f);
  }

  const missing = [];
  for (const rel of referenced) {
    try {
      statSync(resolve(DIST, rel));
    } catch {
      missing.push(rel);
    }
  }
  if (missing.length) {
    console.error(`\n✗ manifest 引用了不存在的文件：${missing.join(', ')}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

function report(results) {
  let total = 0;
  const rows = [];
  for (const { entry, metafile } of results) {
    for (const [file, meta] of Object.entries(metafile.outputs)) {
      if (!file.endsWith('.js')) continue;
      total += meta.bytes;
      rows.push([entry.out, meta.bytes]);
    }
  }
  rows.sort((a, b) => b[1] - a[1]);
  const pad = Math.max(...rows.map((r) => r[0].length));
  console.log('\n产物体积：');
  for (const [name, bytes] of rows) {
    console.log(`  ${name.padEnd(pad)}  ${(bytes / 1024).toFixed(1)} KB`);
  }
  console.log(`  ${'合计'.padEnd(pad)}  ${(total / 1024).toFixed(1)} KB`);
  const budget = 500 * 1024;
  if (total > budget && !watch) {
    console.error(`\n✗ 体积超出预算：${(total / 1024).toFixed(1)} KB > ${budget / 1024} KB`);
    process.exitCode = 1;
  }
}

async function buildAll() {
  const results = [];
  for (const entry of ENTRIES) {
    try {
      const result = await esbuild.build(baseOptions(entry));
      results.push({ entry, metafile: result.metafile ?? { outputs: {} } });
    } catch (err) {
      console.error(`\n✗ 打包失败：${entry.out}`);
      console.error(err.message ?? err);
      process.exitCode = 1;
      return;
    }
  }
  copyStatic();
  const manifest = writeManifest();
  const ok = verifyManifest(manifest);
  if (watch) {
    console.log(ok ? '已构建（watch 模式，源文件变更后重新构建）' : '已构建，但 manifest 校验未通过');
    return;
  }
  report(results);
  const manifestSize = statSync(resolve(DIST, 'manifest.json')).size;
  console.log(`\n${ok ? '✓' : '✗'} dist 已就绪（manifest.json ${manifestSize} B）`);
}

async function main() {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  if (!watch) {
    await buildAll();
    return;
  }

  // watch 模式：静态资源与 manifest 只复制一次，脚本按需重建。
  copyStatic();
  verifyManifest(writeManifest());
  const contexts = [];
  for (const entry of ENTRIES) {
    const ctx = await esbuild.context({ ...baseOptions(entry), plugins: [reporter(entry)] });
    await ctx.watch();
    contexts.push(ctx);
  }
  console.log('watching…');
  process.on('SIGINT', async () => {
    await Promise.all(contexts.map((c) => c.dispose()));
    process.exit(0);
  });
}

function reporter(entry) {
  return {
    name: 'reporter',
    setup(build) {
      build.onEnd((result) => {
        const bytes = Object.entries(result.metafile?.outputs ?? {})
          .filter(([f]) => f.endsWith('.js'))
          .reduce((sum, [, m]) => sum + m.bytes, 0);
        if (result.errors.length) {
          console.error(`✗ ${entry.out} 构建失败`);
        } else {
          console.log(`✓ ${entry.out}  ${(bytes / 1024).toFixed(1)} KB`);
        }
      });
    },
  };
}

await main();
