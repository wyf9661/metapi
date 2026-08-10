import { formatUtcSqlDateTime } from './localTimeService.js';
import {
  fetchDockerHubTagCandidates,
  fetchLatestStableGitHubRelease,
  getCurrentRuntimeVersion,
  type UpdateCenterVersionCandidate,
} from './updateCenterVersionService.js';
import {
  loadUpdateCenterRuntimeState,
  saveUpdateCenterRuntimeState,
  type UpdateCenterRuntimeState,
  type UpdateCenterStatusSnapshot,
} from './updateCenterRuntimeStateService.js';
import { resolveUpdateReminderCandidate, type UpdateReminderCandidate } from './updateCenterReminderService.js';

function summarizeError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || 'unknown error');
}

async function settleOptional<T>(loader: () => Promise<T>): Promise<{
  value: T | null;
  error: string | null;
}> {
  try {
    return {
      value: await loader(),
      error: null,
    };
  } catch (error) {
    return {
      value: null,
      error: summarizeError(error),
    };
  }
}

export type UpdateCenterStatusResult = {
  currentVersion: string;
  githubRelease: UpdateCenterVersionCandidate | null;
  dockerHubTag: UpdateCenterVersionCandidate | null;
  dockerHubRecentTags: UpdateCenterVersionCandidate[];
  runtime: UpdateCenterRuntimeState;
};

function buildStatusSnapshot(status: Pick<UpdateCenterStatusResult, 'githubRelease' | 'dockerHubTag' | 'dockerHubRecentTags'>): UpdateCenterStatusSnapshot {
  return {
    githubRelease: status.githubRelease || null,
    dockerHubTag: status.dockerHubTag || null,
    dockerHubRecentTags: status.dockerHubRecentTags || [],
  };
}

function buildNextRuntimeState(
  status: Pick<UpdateCenterStatusResult, 'currentVersion' | 'githubRelease' | 'dockerHubTag' | 'dockerHubRecentTags'>,
  previousRuntime: UpdateCenterRuntimeState,
  checkedAt: string,
): { candidate: UpdateReminderCandidate | null; nextRuntime: UpdateCenterRuntimeState } {
  const candidate = resolveUpdateReminderCandidate({
    currentVersion: status.currentVersion,
    // Deploy helper (K3s) was removed; the reminder only compares version
    // channels against the running version.
    helper: null,
    githubRelease: status.githubRelease,
    dockerHubTag: status.dockerHubTag,
  });

  return {
    candidate,
    nextRuntime: {
      ...previousRuntime,
      lastCheckedAt: checkedAt,
      lastCheckError: null,
      lastResolvedSource: candidate?.source || null,
      lastResolvedDisplayVersion: candidate?.displayVersion || null,
      lastResolvedCandidateKey: candidate?.candidateKey || null,
      statusSnapshot: buildStatusSnapshot(status),
    },
  };
}

function buildResponseFromState(runtime: UpdateCenterRuntimeState): UpdateCenterStatusResult {
  const snapshot = runtime.statusSnapshot;

  return {
    currentVersion: getCurrentRuntimeVersion(),
    githubRelease: snapshot?.githubRelease || null,
    dockerHubTag: snapshot?.dockerHubTag || null,
    dockerHubRecentTags: snapshot?.dockerHubRecentTags || [],
    runtime,
  };
}

export async function buildUpdateCenterStatus(): Promise<UpdateCenterStatusResult> {
  const [githubLookup, dockerLookup, runtime] = await Promise.all([
    settleOptional(async () => await fetchLatestStableGitHubRelease()),
    settleOptional(async () => await fetchDockerHubTagCandidates()),
    loadUpdateCenterRuntimeState(),
  ]);

  const githubRelease = githubLookup.value;
  const dockerHubCandidates = dockerLookup.value;
  const dockerHubTag = dockerHubCandidates?.primary || null;
  const dockerHubRecentTags = dockerHubCandidates?.recentNonStable || [];

  return {
    currentVersion: getCurrentRuntimeVersion(),
    githubRelease,
    dockerHubTag,
    dockerHubRecentTags,
    runtime,
  };
}

export async function buildCachedUpdateCenterStatus(): Promise<UpdateCenterStatusResult> {
  const runtime = await loadUpdateCenterRuntimeState();
  return buildResponseFromState(runtime);
}

export async function refreshUpdateCenterStatusCache(checkedAt = formatUtcSqlDateTime(new Date())): Promise<{
  status: UpdateCenterStatusResult;
  candidate: UpdateReminderCandidate | null;
  previousRuntime: UpdateCenterRuntimeState;
  runtime: UpdateCenterRuntimeState;
}> {
  const status = await buildUpdateCenterStatus();
  const previousRuntime = status.runtime || await loadUpdateCenterRuntimeState();
  const { candidate, nextRuntime } = buildNextRuntimeState(status, previousRuntime, checkedAt);
  const runtime = await saveUpdateCenterRuntimeState(nextRuntime);
  return {
    status: {
      ...status,
      runtime,
    },
    candidate,
    previousRuntime,
    runtime,
  };
}

export async function getUpdateCenterStatus(): Promise<UpdateCenterStatusResult> {
  const cached = await buildCachedUpdateCenterStatus();
  if (cached.runtime.statusSnapshot) {
    return cached;
  }
  return (await refreshUpdateCenterStatusCache()).status;
}
