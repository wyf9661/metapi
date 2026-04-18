import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'cita-777/metapi';
const README_FILES = ['README.md', 'README_EN.md'] as const;
const START_MARKER = '<!-- metapi-contributors:start -->';
const END_MARKER = '<!-- metapi-contributors:end -->';
const PER_LINE = 10;
const EXCLUDED_LOGINS = new Set(['dependabot[bot]']);

type GitHubContributor = {
  login: string | null;
  html_url: string | null;
  avatar_url: string | null;
  contributions?: number;
};

export type ReadmeContributor = {
  login: string;
  htmlUrl: string;
  avatarUrl: string;
};

export function normalizeContributors(
  contributors: GitHubContributor[],
): ReadmeContributor[] {
  const seen = new Set<string>();

  return contributors
    .filter((contributor) => {
      const login = contributor.login?.trim();
      const htmlUrl = contributor.html_url?.trim();
      const avatarUrl = contributor.avatar_url?.trim();

      if (!login || !htmlUrl || !avatarUrl) {
        return false;
      }

      if (EXCLUDED_LOGINS.has(login.toLowerCase()) || login.toLowerCase().endsWith('[bot]')) {
        return false;
      }

      return true;
    })
    .sort((left, right) => (right.contributions ?? 0) - (left.contributions ?? 0))
    .filter((contributor) => {
      const key = contributor.login!.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map((contributor) => ({
      login: contributor.login!.trim(),
      htmlUrl: contributor.html_url!.trim(),
      avatarUrl: normalizeAvatarUrl(contributor.avatar_url!.trim()),
    }));
}

export function renderContributorsBlock(
  contributors: ReadmeContributor[],
  perLine = PER_LINE,
): string {
  if (!Number.isInteger(perLine) || perLine <= 0) {
    throw new RangeError('perLine must be a positive integer');
  }

  if (contributors.length === 0) {
    return '<p align="left">\n  <sub>No public contributors found yet.</sub>\n</p>';
  }

  const lines: string[] = [];

  for (let index = 0; index < contributors.length; index += perLine) {
    const chunk = contributors.slice(index, index + perLine);
    lines.push(
      `  ${chunk
        .map(
          (contributor) =>
            `<a href="${contributor.htmlUrl}"><img src="${contributor.avatarUrl}" width="48" height="48" alt="${contributor.login}" title="${contributor.login}"/></a>`,
        )
        .join(' ')}`,
    );
  }

  return `<p align="left">\n${lines.join('\n')}\n</p>`;
}

export function replaceContributorsSection(
  readme: string,
  contributors: ReadmeContributor[],
  perLine = PER_LINE,
): string {
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);

  if (start === -1 || end === -1 || end < start) {
    throw new Error('README contributors markers are missing');
  }

  const before = readme.slice(0, start + START_MARKER.length);
  const after = readme.slice(end);
  return `${before}\n${renderContributorsBlock(contributors, perLine)}\n${after}`;
}

export function updateReadmeFile(
  readmePath: string,
  contributors: ReadmeContributor[],
  perLine = PER_LINE,
): boolean {
  const current = readFileSync(readmePath, 'utf8');
  const next = replaceContributorsSection(current, contributors, perLine);
  if (current === next) {
    return false;
  }

  writeFileSync(readmePath, next);
  return true;
}

export function fetchContributors(repo = REPO): ReadmeContributor[] {
  const raw = execFileSync(
    'gh',
    ['api', `repos/${repo}/contributors?per_page=100&anon=1`, '--paginate'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  return normalizeContributors(parsePaginatedJson(raw) as GitHubContributor[]);
}

export function parsePaginatedJson(raw: string): unknown[] {
  const trimmedRaw = raw.trim();
  if (!trimmedRaw) return [];

  try {
    const parsed = JSON.parse(trimmedRaw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Fall through to paginated-array parsing.
  }

  try {
    const mergedArrays = JSON.parse(`[${trimmedRaw.replace(/\]\s*\[/g, '],[')}]`);
    if (Array.isArray(mergedArrays)) {
      return mergedArrays.flatMap((item) => (Array.isArray(item) ? item : [item]));
    }
  } catch {
    // Fall through to line-by-line parsing.
  }

  const items: unknown[] = [];
  for (const line of trimmedRaw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      items.push(...parsed);
    } else {
      items.push(parsed);
    }
  }

  return items;
}

function normalizeAvatarUrl(url: string): string {
  if (!/^https?:/i.test(url)) {
    return url;
  }

  const lower = url.toLowerCase();
  if (lower.includes('s=') || lower.includes('size=')) {
    return url;
  }

  return `${url}${url.includes('?') ? '&' : '?'}s=48`;
}

function main(): void {
  const contributors = fetchContributors(REPO);
  const updatedFiles = README_FILES.filter((path) =>
    updateReadmeFile(resolve(process.cwd(), path), contributors),
  );

  const touched = updatedFiles.length > 0 ? updatedFiles.join(', ') : 'none';
  console.log(`Updated README contributors for ${contributors.length} people: ${touched}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
