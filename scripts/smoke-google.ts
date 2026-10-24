// 一次性联网冒烟脚本：用真实请求验证 Google 引擎的批量请求与解析。
// 用法：npm run smoke:google
import { GoogleEngine, splitBatches } from '../src/engines/google';

const engine = new GoogleEngine();

const texts = [
  'The quick brown fox jumps over the lazy dog.',
  'Translation quality depends heavily on the context you provide.',
  'Click the extension icon to start transcribing audio without subtitles.',
];

console.log('待翻译段落：');
texts.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
console.log(`切批结果：${splitBatches(texts).map((b) => b.length).join(' + ')}`);

const started = Date.now();
const results = await engine.translate(texts, 'auto', 'zh-CN');
console.log(`\n耗时 ${Date.now() - started} ms，返回 ${results.length} 段：`);
results.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));

if (results.length !== texts.length) {
  console.error('\n✗ 段数不匹配');
  process.exit(1);
}
if (results.some((t) => !t || /[\u4e00-\u9fff]/.test(t) === false)) {
  console.error('\n✗ 返回内容看起来不像中文译文');
  process.exit(1);
}
console.log('\n✓ Google 引擎端到端可用');
