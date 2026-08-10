import {
  compareStableVersions,
  isSameImageTarget,
  resolveUpdateReminderCandidate,
  type UpdateHelperRuntimeLike,
  type UpdateVersionCandidateLike,
} from '../../../shared/updateCenterReminder.js';

export type UpdateReminder = {
  label: string;
  badgeClassName: string;
  detail: string;
  highlight: boolean;
};

function normalizeString(value?: string | null): string {
  return String(value || '').trim();
}

function normalizeDigest(value?: string | null): string {
  const digest = normalizeString(value);
  return /^sha256:[a-f0-9]{64}$/i.test(digest) ? digest.toLowerCase() : '';
}

export function buildUpdateReminder(input: {
  currentVersion?: string | null;
  helper: UpdateHelperRuntimeLike | null | undefined;
  githubRelease: UpdateVersionCandidateLike | null | undefined;
  dockerHubTag: UpdateVersionCandidateLike | null | undefined;
}): UpdateReminder {
  const hasGitHubCandidate = Boolean(normalizeString(
    input.githubRelease?.displayVersion
      || input.githubRelease?.normalizedVersion
      || input.githubRelease?.tagName,
  ));
  const hasDockerCandidate = Boolean(normalizeString(
    input.dockerHubTag?.displayVersion
      || input.dockerHubTag?.normalizedVersion
      || input.dockerHubTag?.tagName
      || input.dockerHubTag?.digest,
  ));
  if (!hasGitHubCandidate && !hasDockerCandidate) {
    return {
      label: '无法检查更新',
      badgeClassName: 'badge badge-muted',
      detail: '暂未获取到可比较的版本信息。',
      highlight: false,
    };
  }

  const candidate = resolveUpdateReminderCandidate({
    currentVersion: input.currentVersion,
    helper: input.helper,
    githubRelease: input.githubRelease,
    dockerHubTag: input.dockerHubTag,
  });
  if (candidate) {
    return {
      label: candidate.kind === 'new-digest' ? '发现新 digest' : '发现新版本',
      badgeClassName: 'badge badge-success',
      detail: candidate.kind === 'new-digest'
        ? 'Docker Hub 的 alias tag 已指向新 digest，可按需部署。'
        : candidate.source === 'github-release'
          ? `GitHub 稳定版 ${normalizeString(input.githubRelease?.displayVersion || input.githubRelease?.normalizedVersion)} 已可部署。`
          : `Docker Hub ${normalizeString(input.dockerHubTag?.displayVersion || input.dockerHubTag?.normalizedVersion)} 已可部署。`,
      highlight: true,
    };
  }

  return {
    label: '已是最新',
    badgeClassName: 'badge badge-muted',
    detail: '当前运行版本与已发现的部署目标没有明显差异。',
    highlight: false,
  };
}
