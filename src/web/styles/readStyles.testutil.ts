import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ENTRY = resolve(process.cwd(), 'src/web/index.css');

function expand(file: string): string {
  const content = readFileSync(file, 'utf8');
  return content.replace(/@import\s+"([^"]+\.css)";\n/g, (_, specifier: string) =>
    expand(resolve(dirname(file), specifier)));
}

// The stylesheets are split across src/web/styles/*.css. Source-text tests
// still assert on the effective cascade, so they read the expanded entry
// instead of the (now much smaller) index.css itself.
export function readAllCss(): string {
  return expand(ENTRY);
}
