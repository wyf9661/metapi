type MockLike = ((...args: any[]) => any) & {
  mockImplementation?: (impl: (...args: any[]) => any) => unknown;
};

type AccountsCompatApiMock = {
  getAccounts?: MockLike;
  getAccountsSnapshot?: MockLike;
  getSites?: MockLike;
};

type DashboardCompatApiMock = {
  getDashboard?: MockLike;
  getDashboardSnapshot?: MockLike;
  getDashboardInsights?: MockLike;
  getSiteDistribution?: MockLike;
  getSiteTrend?: MockLike;
  getSites?: MockLike;
  getSiteSnapshot?: MockLike;
};

const FIXTURE_GENERATED_AT = '2026-04-09T00:00:00.000Z';

function buildDerivedSites(accounts: any[]): any[] {
  const siteMap = new Map<number, any>();
  for (const account of accounts) {
    const site = account?.site;
    const siteId = Number(site?.id);
    if (!Number.isFinite(siteId) || siteId <= 0) continue;
    if (!siteMap.has(siteId)) {
      siteMap.set(siteId, { ...site });
    }
  }
  return Array.from(siteMap.values());
}

export function installAccountsSnapshotCompat(apiMock: AccountsCompatApiMock) {
  apiMock.getAccountsSnapshot?.mockImplementation?.(async () => {
    const accountsResult = typeof apiMock.getAccounts === 'function'
      ? await apiMock.getAccounts()
      : [];
    const siteResult = typeof apiMock.getSites === 'function'
      ? await apiMock.getSites()
      : [];
    const accounts = Array.isArray(accountsResult) ? accountsResult : [];
    const sites = Array.isArray(siteResult) && siteResult.length > 0
      ? siteResult
      : buildDerivedSites(accounts);

    return {
      generatedAt: FIXTURE_GENERATED_AT,
      accounts,
      sites,
    };
  });
}

export function installDashboardSnapshotCompat(apiMock: DashboardCompatApiMock) {
  apiMock.getDashboardSnapshot?.mockImplementation?.(async () => {
    if (typeof apiMock.getDashboard !== 'function') return null;
    return apiMock.getDashboard();
  });

  apiMock.getDashboardInsights?.mockImplementation?.(async () => {
    if (typeof apiMock.getDashboard !== 'function') return null;
    return apiMock.getDashboard();
  });

  apiMock.getSiteSnapshot?.mockImplementation?.(async (days = 7) => {
    const distributionResult = typeof apiMock.getSiteDistribution === 'function'
      ? await apiMock.getSiteDistribution()
      : [];
    const trendResult = typeof apiMock.getSiteTrend === 'function'
      ? await apiMock.getSiteTrend(days)
      : [];
    const sitesResult = typeof apiMock.getSites === 'function'
      ? await apiMock.getSites()
      : [];

    return {
      generatedAt: FIXTURE_GENERATED_AT,
      distribution: Array.isArray(distributionResult?.distribution)
        ? distributionResult.distribution
        : Array.isArray(distributionResult)
          ? distributionResult
          : [],
      trend: Array.isArray(trendResult?.trend)
        ? trendResult.trend
        : Array.isArray(trendResult)
          ? trendResult
          : [],
      sites: Array.isArray(sitesResult) ? sitesResult : [],
    };
  });
}
