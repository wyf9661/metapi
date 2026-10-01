import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { translateText } from './i18n.js';

const HAN_RE = /[\u4e00-\u9fff]/;

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkSourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(path) && !/\.test\./.test(path)) out.push(path);
  }
  return out;
}

/** Every literal string passed to `tr(...)` in the web source. */
function collectTrKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of walkSourceFiles(join(process.cwd(), 'src/web'))) {
    const body = readFileSync(file, 'utf8');
    for (const match of body.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(match[1]);
    for (const match of body.matchAll(/\btr\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(match[1]);
  }
  return keys;
}

describe('strict English mode coverage', () => {
  it('never renders the literal "Untranslated" for a source tr() key', () => {
    // Regression guard: the update-center panel shipped seven keys with no
    // supplemental entry, so English mode printed the word "Untranslated" in the
    // UI. A key is only safe when the exact entry exists or phrase replacement
    // leaves Latin/digit text behind.
    const chineseKeys = [...collectTrKeys()].filter((key) => HAN_RE.test(key));
    expect(chineseKeys.length).toBeGreaterThan(100);

    const untranslated = chineseKeys.filter((key) => translateText(key, 'en') === 'Untranslated');
    expect(untranslated).toEqual([]);
  });

  it('translates the update-center strings that previously regressed', () => {
    const expected: Record<string, string> = {
      '从未检查': 'Never checked',
      '已发起回滚': 'Rollback started',
      '当前版本': 'Current version',
      '上次检查': 'Last checked',
      '回滚到更新前版本': 'Roll back to the previous version',
      '上次检查出错': 'Last check failed',
      '基于真实流量学习': 'Learned from real traffic',
      '少样本': 'Small sample',
      '连通': 'Reachable',
      '均延迟': 'Avg latency',
      '可用': 'Available',
      '探测失败': 'Failed',
      '探测中': 'Probing',
      '不通': 'Unreachable',
      '跳过': 'Skipped',
      '已手动停止': 'Manually stopped',
    };
    for (const [zh, en] of Object.entries(expected)) {
      expect(translateText(zh, 'en')).toBe(en);
      // And they must not leak Han into English mode either.
      expect(HAN_RE.test(translateText(zh, 'en'))).toBe(false);
    }
  });
});
