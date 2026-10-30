import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HAN = /[\u4e00-\u9fff]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(path)
      && !/\.test\.|\.testutil\./.test(path)
      && !/i18n\.supplement|[/\\]i18n\.tsx$/.test(path)) out.push(path);
  }
  return out;
}

// Guard: every Chinese literal that could reach the UI goes through tr()/t().
// The few that stay raw are comparison operands (matching upstream wording or a
// stored default), never rendered copy.
describe('English mode coverage', () => {
  it('leaves only comparison operands untranslated', () => {
    const misses: string[] = [];
    for (const file of walk(join(process.cwd(), 'src/web'))) {
      const body = readFileSync(file, 'utf8');
      for (const match of body.matchAll(/(['"])((?:\\.|(?!\1).)*[\u4e00-\u9fff](?:\\.|(?!\1).)*)\1/g)) {
        const before = body.slice(Math.max(0, match.index! - 4), match.index!);
        if (before.endsWith('tr(') || before.endsWith('t(')) continue;
        const lineStart = body.lastIndexOf('\n', match.index!) + 1;
        const line = body.slice(lineStart, body.indexOf('\n', match.index!));
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        if (line.includes('tr(') || line.includes('t(')) continue;
        if (/===|!==|\.includes\(|\.startsWith\(|\.endsWith\(/.test(line)) continue;
        if (/^const [A-Z0-9_]+ = /.test(line.trim()) || line.includes('const DEFAULT_PROFILE_NAME') || line.includes('const OTHER_BRAND_NAME')) continue;
        misses.push(`${file.replace(process.cwd() + '/', '')}: ${line.trim().slice(0, 120)}`);
      }
    }

    expect(misses).toEqual([]);
  });
});
