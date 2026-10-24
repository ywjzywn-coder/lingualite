// 开发用预览服务器：打包 demo 并起一个静态服务，方便在浏览器里直接看气泡效果。
// 用法：npm run demo
import esbuild from 'esbuild';
import { createServer } from 'node:http';
import { copyFile, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_DIR = resolve(ROOT, 'demo');
const PORT = Number(process.env.PORT ?? 5188);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const DEMO_ENTRIES = [
  { entry: 'bubble.ts', out: 'bubble.js' },
  { entry: 'page.ts', out: 'page.js' },
  { entry: 'options.ts', out: 'options.js' },
  { entry: 'popup.ts', out: 'popup.js' },
];

for (const { entry, out } of DEMO_ENTRIES) {
  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [resolve(DEMO_DIR, entry)],
    outfile: resolve(DEMO_DIR, out),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome116'],
    sourcemap: 'inline',
    define: { __DEV__: 'true' },
    jsx: 'automatic',
    jsxImportSource: 'preact',
    // 内容脚本与 Shadow DOM 会按文本内联样式表
    loader: { '.css': 'text' },
    logLevel: 'warning',
  });
}

// 预览页复用正式弹窗的布局和样式，只替换 chrome API。
for (const css of ['tokens.css', 'controls.css', 'components.css']) {
  await copyFile(resolve(ROOT, 'src/ui', css), resolve(DEMO_DIR, css));
}
await copyFile(resolve(ROOT, 'src/popup/popup.html'), resolve(DEMO_DIR, 'popup.html'));
console.log('demo 打包完成');

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname === '/' ? '/options.html' : url.pathname;
  // 只允许访问 demo 目录内的文件
  const file = resolve(join(DEMO_DIR, path));
  if (!file.startsWith(DEMO_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`设置页预览：   http://localhost:${PORT}/options.html`);
  console.log(`弹窗预览：     http://localhost:${PORT}/popup.html`);
  console.log(`气泡预览：     http://localhost:${PORT}/bubble.html`);
  console.log(`网页翻译预览： http://localhost:${PORT}/page.html`);
});
