import { describe, expect, it } from 'vitest';
import {
  parsePaginatedJson,
  normalizeContributors,
  replaceContributorsSection,
  renderContributorsBlock,
} from './update-readme-contributors.js';

describe('README contributors updater', () => {
  it('filters anonymous and bot contributors before rendering', () => {
    const contributors = normalizeContributors([
      {
        login: 'cita-777',
        html_url: 'https://github.com/cita-777',
        avatar_url: 'https://avatars.githubusercontent.com/u/177306803?v=4',
        contributions: 483,
      },
      {
        login: 'dependabot[bot]',
        html_url: 'https://github.com/apps/dependabot',
        avatar_url: 'https://avatars.githubusercontent.com/in/29110?v=4',
        contributions: 12,
      },
      {
        login: null,
        html_url: null,
        avatar_url: null,
        contributions: 22,
      },
      {
        login: 'Babylonehy',
        html_url: 'https://github.com/Babylonehy',
        avatar_url: 'https://avatars.githubusercontent.com/u/30937892?v=4',
        contributions: 3,
      },
    ]);

    expect(contributors).toEqual([
      {
        login: 'cita-777',
        htmlUrl: 'https://github.com/cita-777',
        avatarUrl: 'https://avatars.githubusercontent.com/u/177306803?v=4&s=48',
      },
      {
        login: 'Babylonehy',
        htmlUrl: 'https://github.com/Babylonehy',
        avatarUrl: 'https://avatars.githubusercontent.com/u/30937892?v=4&s=48',
      },
    ]);
  });

  it('replaces the marked README section with an avatar wall', () => {
    const readme = [
      '# Metapi',
      '',
      '<!-- metapi-contributors:start -->',
      'old block',
      '<!-- metapi-contributors:end -->',
      '',
      'tail',
    ].join('\n');

    const next = replaceContributorsSection(readme, [
      {
        login: 'cita-777',
        htmlUrl: 'https://github.com/cita-777',
        avatarUrl: 'https://avatars.githubusercontent.com/u/177306803?v=4&s=48',
      },
      {
        login: 'Hureru',
        htmlUrl: 'https://github.com/Hureru',
        avatarUrl: 'https://avatars.githubusercontent.com/u/121702350?v=4&s=48',
      },
      {
        login: 'Babylonehy',
        htmlUrl: 'https://github.com/Babylonehy',
        avatarUrl: 'https://avatars.githubusercontent.com/u/30937892?v=4&s=48',
      },
    ], 2);

    expect(next).toContain('<p align="left">');
    expect(next).toContain('https://github.com/cita-777');
    expect(next).toContain('https://github.com/Hureru');
    expect(next).toContain('https://github.com/Babylonehy');
    expect(next).not.toContain('old block');
    expect(next).toContain('tail');
  });

  it('renders contributors across multiple rows', () => {
    const html = renderContributorsBlock([
      {
        login: 'cita-777',
        htmlUrl: 'https://github.com/cita-777',
        avatarUrl: 'https://avatars.githubusercontent.com/u/177306803?v=4&s=48',
      },
      {
        login: 'Hureru',
        htmlUrl: 'https://github.com/Hureru',
        avatarUrl: 'https://avatars.githubusercontent.com/u/121702350?v=4&s=48',
      },
      {
        login: 'Babylonehy',
        htmlUrl: 'https://github.com/Babylonehy',
        avatarUrl: 'https://avatars.githubusercontent.com/u/30937892?v=4&s=48',
      },
    ], 2);

    expect(html).toContain('\n  <a href="https://github.com/cita-777"');
    expect(html).toContain('\n  <a href="https://github.com/Babylonehy"');
    expect((html.match(/\n  <a href=/g) || []).length).toBe(2);
  });

  it('rejects invalid per-line values instead of looping forever', () => {
    expect(() => renderContributorsBlock([], 0)).toThrow('perLine must be a positive integer');
  });

  it('parses concatenated paginated gh api arrays without requiring newlines between pages', () => {
    expect(parsePaginatedJson('[{"login":"a"}][{"login":"b"}]')).toEqual([
      { login: 'a' },
      { login: 'b' },
    ]);
  });
});
