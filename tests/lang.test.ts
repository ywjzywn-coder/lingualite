import { describe, expect, it } from 'vitest';
import {
  MIN_SKIP_CONFIDENCE,
  MIN_SKIP_LENGTH,
  shouldSkipAsTarget,
} from '../src/content/page/lang';

// 判定用样例都刻意长于 MIN_SKIP_LENGTH，长度规则单独用短样例测
const ZH = '这是一段中文说明文字，用来测试是否应当跳过这段内容。';
const JA_KANA = 'これは日本語の文章です。ひらがなとカタカナが含まれています。';
/** 刻意不含假名：模拟「检测无力区分、只能按中文处理」的日语片段 */
const JA_KANJI_LONG = '東京都渋谷区神宮前二丁目交差点付近建物外観説明資料';
const KO = '안녕하세요 이것은 한국어로 작성된 테스트 문장입니다.';
const EN = 'This is an English sentence used for testing the detection.';

describe('shouldSkipAsTarget', () => {
  it('目标为自动检测时不跳过', () => {
    expect(shouldSkipAsTarget(ZH, 'zh', 99, 'auto')).toBe(false);
    expect(shouldSkipAsTarget(ZH, 'zh', 99, '')).toBe(false);
  });

  it('没有检测结果时不跳过', () => {
    expect(shouldSkipAsTarget(ZH, undefined, 0, 'zh-CN')).toBe(false);
  });

  it('置信度不足时不跳过', () => {
    expect(shouldSkipAsTarget(ZH, 'zh', MIN_SKIP_CONFIDENCE - 1, 'zh-CN')).toBe(false);
  });

  it('判定为其他语言时不跳过', () => {
    expect(shouldSkipAsTarget(EN, 'en', 99, 'zh-CN')).toBe(false);
    expect(shouldSkipAsTarget(JA_KANA, 'ja', 99, 'zh-CN')).toBe(false);
  });

  it('判定为同一语言且文本够长时跳过', () => {
    expect(shouldSkipAsTarget(ZH, 'zh', 95, 'zh-CN')).toBe(true);
  });

  it('含假名的文本一律不算中文，即使检测说是中文', () => {
    // 中日共用汉字，日语长文很容易被误判成中文；假名是可靠的分界
    expect(shouldSkipAsTarget(JA_KANA, 'zh', 99, 'zh-CN')).toBe(false);
  });

  it('短文本不做跳过判定，交给翻译结果兜底', () => {
    // 搜索结果的标题、按钮、标签这类短片段最容易误判，漏翻比多翻一次代价大
    for (const short of ['网页翻译开关', '東京大学', '设置', 'もっと見る']) {
      expect(short.length).toBeLessThan(MIN_SKIP_LENGTH);
      expect(shouldSkipAsTarget(short, 'zh', 100, 'zh-CN')).toBe(false);
    }
  });

  it('恰好达到长度门槛时仍可跳过', () => {
    const exactly = '一'.repeat(MIN_SKIP_LENGTH);
    expect(shouldSkipAsTarget(exactly, 'zh', 95, 'zh-CN')).toBe(true);
  });

  it('长度门槛之内跳过判定失效，门槛之外生效', () => {
    expect(shouldSkipAsTarget(JA_KANJI_LONG, 'zh', 95, 'zh-CN')).toBe(true);
    expect(shouldSkipAsTarget(JA_KANJI_LONG.slice(0, 5), 'zh', 95, 'zh-CN')).toBe(false);
  });

  it('目标是日语时，含假名的日文照常跳过', () => {
    expect(shouldSkipAsTarget(JA_KANA, 'ja', 95, 'ja')).toBe(true);
    expect(shouldSkipAsTarget(KO, 'ko', 95, 'ko')).toBe(true);
  });

  it('繁体页面配简体目标时不跳过，交由翻译完成繁简转换', () => {
    expect(shouldSkipAsTarget(ZH, 'zh-TW', 95, 'zh-CN')).toBe(false);
  });

  it('目标与判定同为繁体时跳过', () => {
    expect(shouldSkipAsTarget(ZH, 'zh-TW', 95, 'zh-TW')).toBe(true);
  });

  it('判定只给出语言前缀、没有地区时按目标语言处理', () => {
    expect(shouldSkipAsTarget(ZH, 'zh', 95, 'zh-CN')).toBe(true);
  });
});
