import { fetch, type RequestInit as UndiciRequestInit } from 'undici';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type StableSemVer = {
  raw: string;
  normalized: string;
  major: number;
  minor: number;
  patch: number;
};

export type UpdateCenterVersionSource = 'github-release' | 'docker-hub-tag';

export type UpdateCenterVersionCandidate = {
  source: UpdateCenterVersionSource;
  rawVersion: string;
  normalizedVersion: string;
  url: string | null;
};

export type GitHubReleaseRecord = {
  tag_name?: string | null;
  html_url?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  name?: string | null;
};

const STABLE_SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/i;
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/cita-777/metapi/releases';
const DOCKER_HUB_TAGS_URL = 'https://hub.docker.com/v2/repositories/1467078763/metapi/tags?page_size=100';
const UPDATE_CENTER_VERSION_FETCH_TIMEOUT_MS = 5_000;

async function fetchJsonWithTimeout(url: string, init: UndiciRequestInit, timeoutLabel: string): Promise<unknown> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort();
  }, UPDATE_CENTER_VERSION_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${timeoutLabel} failed with HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`${timeoutLabel} timeout (${Math.round(UPDATE_CENTER_VERSION_FETCH_TIMEOUT_MS / 1000)}s)`);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  }
}

export function parseStableSemVer(input: string | null | undefined): StableSemVer | null {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const match = raw.match(STABLE_SEMVER_PATTERN);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (![major, minor, patch].every(Number.isFinite)) return null;
  return {
    raw,
    normalized: `${major}.${minor}.${patch}`,
    major,
    minor,
    patch,
  };
}

export function compareStableSemVer(a: StableSemVer, b: StableSemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function selectLatestStableGitHubRelease(
  releases: GitHubReleaseRecord[],
): UpdateCenterVersionCandidate | null {
  let selected: { semver: StableSemVer; release: GitHubReleaseRecord } | null = null;

  for (const release of releases) {
    if (release?.draft || release?.prerelease) continue;
    const semver = parseStableSemVer(release?.tag_name);
    if (!semver) continue;
    if (!selected || compareStableSemVer(semver, selected.semver) > 0) {
      selected = { semver, release };
    }
  }

  if (!selected) return null;

  return {
    source: 'github-release',
    rawVersion: selected.release.tag_name || selected.semver.raw,
    normalizedVersion: selected.semver.normalized,
    url: selected.release.html_url || null,
  };
}

export function selectLatestDockerHubTag(tags: string[]): UpdateCenterVersionCandidate | null {
  let selected: StableSemVer | null = null;

  for (const tag of tags) {
    const semver = parseStableSemVer(tag);
    if (!semver) continue;
    if (!selected || compareStableSemVer(semver, selected) > 0) {
      selected = semver;
    }
  }

  if (!selected) return null;

  return {
    source: 'docker-hub-tag',
    rawVersion: selected.raw,
    normalizedVersion: selected.normalized,
    url: null,
  };
}

export function resolvePreferredDeploySource(input: {
  defaultSource: UpdateCenterVersionSource;
  githubRelease: UpdateCenterVersionCandidate | null;
  dockerHubTag: UpdateCenterVersionCandidate | null;
}): UpdateCenterVersionCandidate | null {
  if (input.defaultSource === 'github-release') {
    return input.githubRelease || input.dockerHubTag;
  }
  return input.dockerHubTag || input.githubRelease;
}

export async function fetchLatestStableGitHubRelease(): Promise<UpdateCenterVersionCandidate | null> {
  const releases = await fetchJsonWithTimeout(GITHUB_RELEASES_URL, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'metapi-update-center/1.0',
    },
  }, 'GitHub releases lookup') as GitHubReleaseRecord[];
  return selectLatestStableGitHubRelease(Array.isArray(releases) ? releases : []);
}

export async function fetchLatestDockerHubTag(): Promise<UpdateCenterVersionCandidate | null> {
  const payload = await fetchJsonWithTimeout(DOCKER_HUB_TAGS_URL, {
    headers: {
      accept: 'application/json',
      'user-agent': 'metapi-update-center/1.0',
    },
  }, 'Docker Hub tag lookup') as { results?: Array<{ name?: string | null }> };
  const tags = Array.isArray(payload?.results)
    ? payload.results.map((item) => String(item?.name || '')).filter(Boolean)
    : [];
  return selectLatestDockerHubTag(tags);
}

export function getCurrentRuntimeVersion(): string {
  try {
    const packageJsonPath = resolve(process.cwd(), 'package.json');
    const payload = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    const version = String(payload?.version || '').trim();
    return version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
