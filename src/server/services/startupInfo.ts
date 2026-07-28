type StartupSummaryInput = {
  port: number;
  host: string;
  authToken: string;
};

type StartupEndpoints = {
  baseUrl: string;
  adminDashboardUrl: string;
  adminApiExample: string;
  proxyApiExample: string;
  adminApiCurl: string;
  proxyApiCurl: string;
};

function resolveDisplayHost(host: string): string {
  const trimmed = (host || '').trim();
  if (!trimmed || trimmed === '0.0.0.0' || trimmed === '::') return '127.0.0.1';
  return trimmed;
}

export function buildStartupEndpoints(input: StartupSummaryInput): StartupEndpoints {
  const displayHost = resolveDisplayHost(input.host);
  const baseUrl = `http://${displayHost}:${input.port}`;

  const adminApiExample = `${baseUrl}/api/stats/dashboard`;
  const proxyApiExample = `${baseUrl}/v1/chat/completions`;

  return {
    baseUrl,
    adminDashboardUrl: baseUrl,
    adminApiExample,
    proxyApiExample,
    adminApiCurl: `curl '${adminApiExample}' -H 'Authorization: Bearer ***'`,
    proxyApiCurl: `curl '${proxyApiExample}' -H 'Authorization: Bearer ***' -H 'Content-Type: application/json' -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}'`,
  };
}

export function buildStartupSummaryLines(input: StartupSummaryInput): string[] {
  const endpoints = buildStartupEndpoints(input);

  return [
    `metapi running on ${input.host}:${input.port}`,
    `Dashboard: ${endpoints.adminDashboardUrl}`,
    `Admin API: ${endpoints.adminApiExample}`,
    `Proxy API: ${endpoints.proxyApiExample}`,
    `Admin curl: ${endpoints.adminApiCurl}`,
    `Proxy curl: ${endpoints.proxyApiCurl}`,
  ];
}
