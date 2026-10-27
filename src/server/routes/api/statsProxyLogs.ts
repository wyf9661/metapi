import type { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import {
  parseProxyLogBillingDetails,
  withProxyLogSelectFields,
} from '../../services/proxyLogStore.js';
import { proxyLogEventBus, type ProxyLogEvent } from '../../services/proxyLogEventBus.js';
import { parseProxyLogMessageMeta } from '../../services/proxyLogMessage.js';
import { canonicalizeModelName } from '../../shared/modelCanonicalization.js';
import {formatUtcSqlDateTime} from '../../services/localTimeService.js';
import {
  normalizeProxyLogsView,
  normalizeProxyLogPageSize,
  normalizeProxyLogOffset,
  normalizeProxyLogSearch,
  normalizeProxyLogSiteId,
  parseDownstreamKeyTags,
  toRoundedMicroNumber,
  normalizeNullableText,
  normalizeClientConfidence,
} from './stats.pure.js';


/**
 * Proxy log query, list, detail and SSE push endpoints, split out of
 * statsRoutes. Registered by direct call so the Fastify encapsulation context
 * and auth hooks stay identical. The SSE route must stay above /:id so
 * "stream" is not captured as a path parameter.
 */
type ProxyLogStatusFilter = 'all' | 'success' | 'failed';

type ProxyLogClientFilter = {
  kind: 'app' | 'family';
  value: string;
} | null;

type ProxyLogClientOption = {
  value: string;
  label: string;
};

const PROXY_LOG_CLIENT_FAMILY_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude_code: 'Claude Code',
  gemini_cli: 'Gemini CLI',
  generic: '通用',
};

function normalizeProxyLogStatusFilter(raw?: string): ProxyLogStatusFilter {
  const normalized = (raw || '').trim().toLowerCase();
  if (normalized === 'success') return 'success';
  if (normalized === 'failed') return 'failed';
  return 'all';
}

function normalizeProxyLogModelFilter(raw?: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return canonicalizeModelName(trimmed) || trimmed;
}

function normalizeProxyLogClientFilter(raw?: string): ProxyLogClientFilter {
  const text = (raw || '').trim();
  if (!text) return null;
  const separatorIndex = text.indexOf(':');
  if (separatorIndex <= 0) return null;
  const kind = text.slice(0, separatorIndex).trim().toLowerCase();
  const value = text
    .slice(separatorIndex + 1)
    .trim()
    .toLowerCase();
  if (!value) return null;
  if (kind === 'app' || kind === 'family') {
    return { kind, value };
  }
  return null;
}

function normalizeProxyLogTimeBoundary(raw?: string): string | null {
  const text = (raw || '').trim();
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatUtcSqlDateTime(parsed);
}

function buildProxyLogSearchCondition(search: string) {
  if (!search) return null;
  const likeTerm = `%${search}%`;
  return sql<boolean>`(
    lower(coalesce(${schema.proxyLogs.modelRequested}, '')) like ${likeTerm}
    or lower(coalesce(${schema.proxyLogs.modelActual}, '')) like ${likeTerm}
    or lower(coalesce(${schema.downstreamApiKeys.name}, '')) like ${likeTerm}
    or lower(coalesce(${schema.downstreamApiKeys.groupName}, '')) like ${likeTerm}
    or lower(coalesce(${schema.downstreamApiKeys.tags}, '')) like ${likeTerm}
  )`;
}

function buildProxyLogStatusCondition(status: ProxyLogStatusFilter) {
  if (status === 'success') {
    return eq(schema.proxyLogs.status, 'success');
  }
  if (status === 'failed') {
    return sql<boolean>`coalesce(${schema.proxyLogs.status}, '') <> 'success'`;
  }
  return null;
}

function buildProxyLogClientCondition(client: ProxyLogClientFilter) {
  if (!client) return null;
  if (client.kind === 'app') {
    return eq(schema.proxyLogs.clientAppId, client.value);
  }
  return eq(schema.proxyLogs.clientFamily, client.value);
}

function buildProxyLogWhereClause(params: {
  status?: ProxyLogStatusFilter;
  search?: string;
  client?: ProxyLogClientFilter;
  downstreamKeyId?: number | null;
  siteId?: number | null;
  model?: string | null;
  fromUtc?: string | null;
  toUtc?: string | null;
}) {
  const downstreamKeyCondition = params.downstreamKeyId
    ? eq(schema.proxyLogs.downstreamApiKeyId, params.downstreamKeyId)
    : null;
  const modelCondition = params.model
    ? sql<boolean>`(
        lower(trim(coalesce(nullif(${schema.proxyLogs.modelActual}, ''), ${schema.proxyLogs.modelRequested}, ''))) = ${params.model}
        or lower(trim(coalesce(nullif(${schema.proxyLogs.modelActual}, ''), ${schema.proxyLogs.modelRequested}, ''))) = ${`${params.model}:free`}
        or lower(trim(coalesce(nullif(${schema.proxyLogs.modelActual}, ''), ${schema.proxyLogs.modelRequested}, ''))) = ${`${params.model}-free`}
        or lower(trim(coalesce(nullif(${schema.proxyLogs.modelActual}, ''), ${schema.proxyLogs.modelRequested}, ''))) like ${`%/${params.model}`}
        or lower(trim(coalesce(nullif(${schema.proxyLogs.modelActual}, ''), ${schema.proxyLogs.modelRequested}, ''))) like ${`%/${params.model}:free`}
        or lower(trim(coalesce(nullif(${schema.proxyLogs.modelActual}, ''), ${schema.proxyLogs.modelRequested}, ''))) like ${`%/${params.model}-free`}
      )`
    : null;
  const conditions = [
    params.status ? buildProxyLogStatusCondition(params.status) : null,
    params.search ? buildProxyLogSearchCondition(params.search) : null,
    params.client ? buildProxyLogClientCondition(params.client) : null,
    downstreamKeyCondition,
    params.siteId ? eq(schema.sites.id, params.siteId) : null,
    modelCondition,
    params.fromUtc ? gte(schema.proxyLogs.createdAt, params.fromUtc) : null,
    params.toUtc ? lt(schema.proxyLogs.createdAt, params.toUtc) : null,
  ].filter(
    (condition): condition is NonNullable<typeof condition> =>
      condition !== null,
  );

  if (conditions.length === 0) return undefined;
  return conditions.length === 1 ? conditions[0] : and(...conditions);
}

function displayProxyLogClientFamily(value: string | null): string | null {
  if (!value) return null;
  return PROXY_LOG_CLIENT_FAMILY_LABELS[value] || value;
}

function resolveProxyLogClientMeta(proxyLog: Record<string, unknown>) {
  const clientFamily =
    normalizeNullableText(proxyLog.clientFamily)?.toLowerCase() || null;
  const clientAppId =
    normalizeNullableText(proxyLog.clientAppId)?.toLowerCase() || null;
  const clientAppName = normalizeNullableText(proxyLog.clientAppName) || null;
  const clientConfidence = normalizeClientConfidence(proxyLog.clientConfidence);

  if (clientFamily || clientAppId || clientAppName || clientConfidence) {
    return {
      clientFamily,
      clientAppId,
      clientAppName,
      clientConfidence,
    };
  }

  const legacyMeta = parseProxyLogMessageMeta(
    typeof proxyLog.errorMessage === 'string' ? proxyLog.errorMessage : '',
  );
  return {
    clientFamily:
      normalizeNullableText(legacyMeta.clientKind)?.toLowerCase() || null,
    clientAppId: null,
    clientAppName: null,
    clientConfidence: null,
  };
}

function normalizeProxyLogUsageSource(
  value: unknown,
): 'upstream' | 'self-log' | 'unknown' | null {
  const normalized = normalizeNullableText(value)?.toLowerCase() || null;
  if (
    normalized === 'upstream' ||
    normalized === 'self-log' ||
    normalized === 'unknown'
  ) {
    return normalized;
  }
  return null;
}

function buildProxyLogClientOptions(
  rows: Array<{
    clientFamily?: string | null;
    clientAppId?: string | null;
    clientAppName?: string | null;
  }>,
): ProxyLogClientOption[] {
  const appOptions = new Map<string, ProxyLogClientOption>();
  const familyOptions = new Map<string, ProxyLogClientOption>();

  for (const row of rows) {
    const clientAppId =
      normalizeNullableText(row.clientAppId)?.toLowerCase() || null;
    const clientAppName = normalizeNullableText(row.clientAppName) || null;
    const clientFamily =
      normalizeNullableText(row.clientFamily)?.toLowerCase() || null;

    if (clientAppId && clientAppName && !appOptions.has(clientAppId)) {
      appOptions.set(clientAppId, {
        value: `app:${clientAppId}`,
        label: `应用 · ${clientAppName}`,
      });
    }

    if (
      clientFamily &&
      clientFamily !== 'generic' &&
      !familyOptions.has(clientFamily)
    ) {
      familyOptions.set(clientFamily, {
        value: `family:${clientFamily}`,
        label: `协议 · ${displayProxyLogClientFamily(clientFamily) || clientFamily}`,
      });
    }
  }

  return [
    ...Array.from(appOptions.values()).sort((left, right) =>
      left.label.localeCompare(right.label, 'zh-CN'),
    ),
    ...Array.from(familyOptions.values()).sort((left, right) =>
      left.label.localeCompare(right.label, 'zh-CN'),
    ),
  ];
}

function mapProxyLogRow(
  row: {
    proxy_logs: Record<string, unknown> & { billingDetails?: string | null };
    accounts: { username?: string | null } | null;
    sites: {
      id?: number | null;
      name?: string | null;
      url?: string | null;
    } | null;
    account_tokens?: {
      name?: string | null;
      tokenGroup?: string | null;
    } | null;
    downstream_api_keys: {
      id?: number | null;
      name?: string | null;
      groupName?: string | null;
      tags?: string | null;
    } | null;
  },
  options?: { includeBillingDetails?: boolean },
) {
  const clientMeta = resolveProxyLogClientMeta(row.proxy_logs);
  const legacyMeta = parseProxyLogMessageMeta(
    typeof row.proxy_logs.errorMessage === 'string'
      ? row.proxy_logs.errorMessage
      : '',
  );
  return {
    ...row.proxy_logs,
    isStream:
      row.proxy_logs.isStream == null ? null : Boolean(row.proxy_logs.isStream),
    firstByteLatencyMs:
      typeof row.proxy_logs.firstByteLatencyMs === 'number'
        ? row.proxy_logs.firstByteLatencyMs
        : null,
    ...(options?.includeBillingDetails
      ? {
          billingDetails: parseProxyLogBillingDetails(
            row.proxy_logs.billingDetails,
          ),
        }
      : {}),
    clientFamily: clientMeta.clientFamily,
    clientAppId: clientMeta.clientAppId,
    clientAppName: clientMeta.clientAppName,
    clientConfidence: clientMeta.clientConfidence,
    usageSource: normalizeProxyLogUsageSource(legacyMeta.usageSource),
    username: row.accounts?.username || null,
    tokenId: typeof row.proxy_logs.tokenId === 'number' ? row.proxy_logs.tokenId : null,
    tokenName: row.account_tokens?.name || null,
    tokenGroup: row.account_tokens?.tokenGroup || null,
    siteId: row.sites?.id || null,
    siteName: row.sites?.name || null,
    siteUrl: row.sites?.url || null,
    downstreamKeyId: row.downstream_api_keys?.id || null,
    downstreamKeyName: row.downstream_api_keys?.name || null,
    downstreamKeyGroupName: row.downstream_api_keys?.groupName || null,
    downstreamKeyTags: parseDownstreamKeyTags(row.downstream_api_keys?.tags),
  };
}

export function registerStatsProxyLogsRoutes(app: FastifyInstance): void {
  async function loadProxyLogsQueryPayload(params: {
    limit?: string;
    offset?: string;
    status?: string;
    search?: string;
    client?: string;
    downstreamKeyId?: string;
    siteId?: string;
    model?: string;
    from?: string;
    to?: string;
  }) {
    const limit = normalizeProxyLogPageSize(params.limit);
    const offset = normalizeProxyLogOffset(params.offset);
    const status = normalizeProxyLogStatusFilter(params.status);
    const search = normalizeProxyLogSearch(params.search);
    const client = normalizeProxyLogClientFilter(params.client);
    const downstreamKeyId = normalizeProxyLogSiteId(params.downstreamKeyId);
    const siteId = normalizeProxyLogSiteId(params.siteId);
    const model = normalizeProxyLogModelFilter(params.model);
    const fromUtc = normalizeProxyLogTimeBoundary(params.from);
    const toUtc = normalizeProxyLogTimeBoundary(params.to);
    // A search term forces a full-table scan because `LIKE '%kw%'` cannot
    // use an index. When the caller searches without an explicit start
    // time, constrain the scan to the retention window (which is indexed)
    // instead of scanning the entire proxy_logs table.
    const effectiveFromUtc = fromUtc
      || (search
        ? formatUtcSqlDateTime(new Date(Date.now() - Math.max(1, Math.trunc(config.proxyLogRetentionDays || 30)) * 24 * 60 * 60 * 1000))
        : null);
    const listWhere = buildProxyLogWhereClause({
      status,
      search,
      client,
      downstreamKeyId,
      siteId,
      model,
      fromUtc: effectiveFromUtc,
      toUtc,
    });

    // Pagination unit is one logical *request*, not one attempt row. Retries of
    // the same request (same requestTraceId, folded per site) share one row in
    // the UI, so paginating raw attempt rows made a page render fewer than
    // `limit` items whenever it happened to contain a retry — the count would
    // visibly jitter (10, 9, 8, 6...). We group here so both the page slice and
    // the total are counted in requests, keeping the two in the same unit.
    //
    // Group key mirrors the former client-side fold: (requestTraceId, siteId)
    // when both are present, otherwise each row is its own group. To stay
    // portable across sqlite/mysql/postgres we avoid string concat and instead
    // partition on two derived columns — a non-groupable row gets a NULL trace
    // and its own proxy_logs.id in the site slot, which is globally unique, so
    // it forms a singleton partition.
    const groupablePredicate = sql`(${schema.proxyLogs.requestTraceId} is not null and ${schema.proxyLogs.requestTraceId} <> '' and ${schema.sites.id} is not null)`;
    const effectiveTraceKey = sql`case when ${groupablePredicate} then ${schema.proxyLogs.requestTraceId} else null end`;
    const effectiveSiteKey = sql`case when ${groupablePredicate} then ${schema.sites.id} else ${schema.proxyLogs.id} end`;

    const pageGroups = await withProxyLogSelectFields(
      async ({ includeRequestTraceId }) => {
        if (!includeRequestTraceId) {
          // Legacy DB without request_trace_id: no reliable retry key, so fall
          // back to per-attempt pagination (matches historical behavior).
          let legacyIdQuery: any = db
            .select({ id: schema.proxyLogs.id })
            .from(schema.proxyLogs)
            .leftJoin(
              schema.accounts,
              eq(schema.proxyLogs.accountId, schema.accounts.id),
            )
            .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
            .leftJoin(
              schema.downstreamApiKeys,
              eq(
                schema.proxyLogs.downstreamApiKeyId,
                schema.downstreamApiKeys.id,
              ),
            );
          if (listWhere) legacyIdQuery = legacyIdQuery.where(listWhere);
          const legacyRows = await legacyIdQuery
            .orderBy(desc(schema.proxyLogs.createdAt), desc(schema.proxyLogs.id))
            .limit(limit)
            .offset(offset)
            .all();

          let legacyTotalQuery: any = db
            .select({ total: sql<number>`count(*)` })
            .from(schema.proxyLogs);
          if (siteId) {
            legacyTotalQuery = legacyTotalQuery
              .leftJoin(
                schema.accounts,
                eq(schema.proxyLogs.accountId, schema.accounts.id),
              )
              .leftJoin(
                schema.sites,
                eq(schema.accounts.siteId, schema.sites.id),
              );
          }
          if (search) {
            legacyTotalQuery = legacyTotalQuery.leftJoin(
              schema.downstreamApiKeys,
              eq(
                schema.proxyLogs.downstreamApiKeyId,
                schema.downstreamApiKeys.id,
              ),
            );
          }
          if (listWhere) legacyTotalQuery = legacyTotalQuery.where(listWhere);
          const legacyTotalRow = await legacyTotalQuery.get();
          return {
            ids: legacyRows.map((r: { id: number }) => Number(r.id)),
            attemptById: new Map<number, number>(),
            total: Number(legacyTotalRow?.total || 0),
          };
        }

        // Grouped path: rank attempts within each request group and keep the
        // most recent as the representative row; attach the attempt count so
        // the caller can expose retryCount = attempts - 1.
        let rankedBase: any = db
          .select({
            id: schema.proxyLogs.id,
            createdAt: schema.proxyLogs.createdAt,
            rn: sql<number>`row_number() over (partition by ${effectiveTraceKey}, ${effectiveSiteKey} order by ${schema.proxyLogs.createdAt} desc, ${schema.proxyLogs.id} desc)`.as('rn'),
            attemptCount: sql<number>`count(*) over (partition by ${effectiveTraceKey}, ${effectiveSiteKey})`.as('attempt_count'),
          })
          .from(schema.proxyLogs)
          .leftJoin(
            schema.accounts,
            eq(schema.proxyLogs.accountId, schema.accounts.id),
          )
          .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
          .leftJoin(
            schema.downstreamApiKeys,
            eq(
              schema.proxyLogs.downstreamApiKeyId,
              schema.downstreamApiKeys.id,
            ),
          );
        if (listWhere) rankedBase = rankedBase.where(listWhere);
        const ranked = rankedBase.as('ranked');

        const groupRows = await db
          .select({
            id: ranked.id,
            createdAt: ranked.createdAt,
            attemptCount: ranked.attemptCount,
          })
          .from(ranked)
          .where(eq(ranked.rn, 1))
          .orderBy(desc(ranked.createdAt), desc(ranked.id))
          .limit(limit)
          .offset(offset)
          .all();

        // Total = number of request groups (COUNT over a GROUP BY subquery,
        // portable everywhere; COUNT(DISTINCT composite) is not).
        let groupTotalBase: any = db
          .select({ one: sql<number>`1` })
          .from(schema.proxyLogs)
          .leftJoin(
            schema.accounts,
            eq(schema.proxyLogs.accountId, schema.accounts.id),
          )
          .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
          .leftJoin(
            schema.downstreamApiKeys,
            eq(
              schema.proxyLogs.downstreamApiKeyId,
              schema.downstreamApiKeys.id,
            ),
          );
        if (listWhere) groupTotalBase = groupTotalBase.where(listWhere);
        const groupTotalSub = groupTotalBase
          .groupBy(effectiveTraceKey, effectiveSiteKey)
          .as('groups');
        const groupTotalRow = await db
          .select({ total: sql<number>`count(*)` })
          .from(groupTotalSub)
          .get();

        const attemptById = new Map<number, number>();
        for (const r of groupRows as Array<{ id: number; attemptCount?: number | string | null }>) {
          attemptById.set(Number(r.id), Number(r.attemptCount || 1));
        }
        return {
          ids: (groupRows as Array<{ id: number }>).map((r) => Number(r.id)),
          attemptById,
          total: Number(groupTotalRow?.total || 0),
        };
      },
      { includeRequestTraceId: true, includeClientFields: false },
    );

    if (pageGroups.ids.length === 0) {
      return {
        items: [],
        total: pageGroups.total,
        page: Math.floor(offset / limit) + 1,
        pageSize: limit,
      };
    }

    // Hydrate the representative rows for this page (order-agnostic fetch, then
    // re-order to the group ranking above).
    const fullRows = (await withProxyLogSelectFields(
      ({ fields }) =>
        db
          .select({
            proxy_logs: fields,
            accounts: {
              username: schema.accounts.username,
            },
            sites: {
              id: schema.sites.id,
              name: schema.sites.name,
              url: schema.sites.url,
            },
            account_tokens: {
              name: schema.accountTokens.name,
              tokenGroup: schema.accountTokens.tokenGroup,
            },
            downstream_api_keys: {
              id: schema.downstreamApiKeys.id,
              name: schema.downstreamApiKeys.name,
              groupName: schema.downstreamApiKeys.groupName,
              tags: schema.downstreamApiKeys.tags,
            },
          })
          .from(schema.proxyLogs)
          .leftJoin(
            schema.accounts,
            eq(schema.proxyLogs.accountId, schema.accounts.id),
          )
          .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
          .leftJoin(
            schema.accountTokens,
            eq(schema.proxyLogs.tokenId, schema.accountTokens.id),
          )
          .leftJoin(
            schema.downstreamApiKeys,
            eq(
              schema.proxyLogs.downstreamApiKeyId,
              schema.downstreamApiKeys.id,
            ),
          )
          .where(inArray(schema.proxyLogs.id, pageGroups.ids))
          .all(),
      { includeBillingDetails: false, includeRequestTraceId: true },
    )) as Array<{
      proxy_logs: Record<string, unknown> & {
        id?: number;
        retryCount?: number | null;
        billingDetails?: string | null;
      };
      accounts: { username?: string | null } | null;
      sites: {
        id?: number | null;
        name?: string | null;
        url?: string | null;
      } | null;
      account_tokens: {
        name?: string | null;
        tokenGroup?: string | null;
      } | null;
      downstream_api_keys: {
        id?: number | null;
        name?: string | null;
        groupName?: string | null;
        tags?: string | null;
      } | null;
    }>;

    const rowById = new Map<number, (typeof fullRows)[number]>();
    for (const row of fullRows) rowById.set(Number(row.proxy_logs.id), row);

    type MappedProxyLogItem = ReturnType<typeof mapProxyLogRow> & {
      retryCount?: number | null;
    };

    const items: Array<MappedProxyLogItem> = pageGroups.ids.flatMap(
      (id: number): MappedProxyLogItem[] => {
        const row = rowById.get(id);
        if (!row) return [];
        const mapped: MappedProxyLogItem = mapProxyLogRow(row);
        const attempts = pageGroups.attemptById.get(id) || 1;
        // >1 attempt means retries were folded: retryCount = attempts - 1.
        // Singletons keep whatever retryCount the final attempt stored.
        if (attempts > 1) mapped.retryCount = attempts - 1;
        return [mapped];
      },
    );

    return {
      items,
      total: pageGroups.total,
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
    };
  }

  async function loadProxyLogsMetaPayload(params: {
    status?: string;
    search?: string;
    client?: string;
    downstreamKeyId?: string;
    siteId?: string;
    model?: string;
    from?: string;
    to?: string;
  }) {
    const status = normalizeProxyLogStatusFilter(params.status);
    const search = normalizeProxyLogSearch(params.search);
    const client = normalizeProxyLogClientFilter(params.client);
    const downstreamKeyId = normalizeProxyLogSiteId(params.downstreamKeyId);
    const siteId = normalizeProxyLogSiteId(params.siteId);
    const model = normalizeProxyLogModelFilter(params.model);
    const fromUtc = normalizeProxyLogTimeBoundary(params.from);
    const toUtc = normalizeProxyLogTimeBoundary(params.to);
    const summaryWhere = buildProxyLogWhereClause({
      search,
      client,
      downstreamKeyId,
      siteId,
      model,
      fromUtc,
      toUtc,
    });
    const clientOptionsWhere = buildProxyLogWhereClause({
      status,
      search,
      siteId,
      downstreamKeyId,
      model,
      fromUtc,
      toUtc,
    });
    const modelOptionsWhere = buildProxyLogWhereClause({
      status,
      search,
      client,
      downstreamKeyId,
      siteId,
      fromUtc,
      toUtc,
    });

    const clientOptionRowsPromise = withProxyLogSelectFields(
      ({ fields, includeClientFields }) => {
        if (!includeClientFields) {
          return Promise.resolve([]);
        }

        let query = db
          .select({
            clientFamily: fields.clientFamily!,
            clientAppId: fields.clientAppId!,
            clientAppName: fields.clientAppName!,
          })
          .from(schema.proxyLogs)
          .leftJoin(
            schema.accounts,
            eq(schema.proxyLogs.accountId, schema.accounts.id),
          )
          .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
          .leftJoin(
            schema.downstreamApiKeys,
            eq(
              schema.proxyLogs.downstreamApiKeyId,
              schema.downstreamApiKeys.id,
            ),
          );

        if (clientOptionsWhere) {
          query = query.where(clientOptionsWhere) as typeof query;
        }

        return query
          .groupBy(
            fields.clientFamily!,
            fields.clientAppId!,
            fields.clientAppName!,
          )
          .all();
      },
      { includeBillingDetails: false, includeClientFields: true },
    ) as Promise<
      Array<{
        clientFamily?: string | null;
        clientAppId?: string | null;
        clientAppName?: string | null;
      }>
    >;

    const modelOptionRowsPromise = (async () => {
      let query = db
        .select({
          modelActual: schema.proxyLogs.modelActual,
          modelRequested: schema.proxyLogs.modelRequested,
        })
        .from(schema.proxyLogs)
        .leftJoin(
          schema.accounts,
          eq(schema.proxyLogs.accountId, schema.accounts.id),
        )
        .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .leftJoin(
          schema.downstreamApiKeys,
          eq(
            schema.proxyLogs.downstreamApiKeyId,
            schema.downstreamApiKeys.id,
          ),
        );
      if (modelOptionsWhere) {
        query = query.where(modelOptionsWhere) as typeof query;
      }
      return query
        .groupBy(schema.proxyLogs.modelActual, schema.proxyLogs.modelRequested)
        .all();
    })();

    // Site filter options are derived from the usage logs themselves, not
    // from every row in `sites`. Logs join through accounts, so a site whose
    // accounts were removed (or never had any) has no rows left — listing it
    // anyway is what kept deleted sites in the dropdown while every log
    // query for them returned nothing.
    const siteRows = await (async () => {
      const query = db
        .select({
          id: schema.sites.id,
          name: schema.sites.name,
          status: schema.sites.status,
        })
        .from(schema.proxyLogs)
        .innerJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .groupBy(schema.sites.id)
        .orderBy(schema.sites.id);
      return query.all();
    })();

    const [clientOptionRows, summaryRow, modelOptionRows, downstreamKeyRows] = await Promise.all([
      clientOptionRowsPromise,
      (async () => {
        let summaryQuery = db
          .select({
            totalCount: sql<number>`count(*)`,
            successCount: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 1 else 0 end), 0)`,
            failedCount: sql<number>`coalesce(sum(case when coalesce(${schema.proxyLogs.status}, '') <> 'success' then 1 else 0 end), 0)`,
            totalCost: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.estimatedCost}, 0)), 0)`,
            totalTokensAll: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.totalTokens}, 0)), 0)`,
          })
          .from(schema.proxyLogs)
          .leftJoin(
            schema.accounts,
            eq(schema.proxyLogs.accountId, schema.accounts.id),
          )
          .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
          .leftJoin(
            schema.downstreamApiKeys,
            eq(
              schema.proxyLogs.downstreamApiKeyId,
              schema.downstreamApiKeys.id,
            ),
          );
        if (summaryWhere) {
          summaryQuery = summaryQuery.where(
            summaryWhere,
          ) as typeof summaryQuery;
        }
        return summaryQuery.get();
      })(),
      modelOptionRowsPromise,
      db
        .select({
          id: schema.downstreamApiKeys.id,
          name: schema.downstreamApiKeys.name,
          groupName: schema.downstreamApiKeys.groupName,
        })
        .from(schema.downstreamApiKeys)
        .all(),
    ]);

    return {
      clientOptions: buildProxyLogClientOptions(clientOptionRows),
      downstreamKeys: downstreamKeyRows.map((row: { id: number; name: string | null; groupName: string | null }) => ({
        id: row.id,
        name: row.name || '',
        groupName: row.groupName || null,
      })),
      summary: {
        totalCount: Number(summaryRow?.totalCount || 0),
        successCount: Number(summaryRow?.successCount || 0),
        failedCount: Number(summaryRow?.failedCount || 0),
        totalCost: toRoundedMicroNumber(summaryRow?.totalCost),
        totalTokensAll: Number(summaryRow?.totalTokensAll || 0),
      },
      sites: siteRows,
      models: (() => {
        const names = new Set<string>();
        for (const row of modelOptionRows || []) {
          const raw = String(row.modelActual || row.modelRequested || '').trim();
          if (!raw) continue;
          names.add(canonicalizeModelName(raw) || raw);
        }
        return Array.from(names).sort((left: string, right: string) =>
          left.localeCompare(right, 'zh-CN'),
        );
      })(),
    };
  }

  app.get<{
    Querystring: {
      limit?: string;
      offset?: string;
      status?: string;
      search?: string;
      client?: string;
      siteId?: string;
      model?: string;
      from?: string;
      to?: string;
      view?: string;
    };
  }>('/api/stats/proxy-logs', async (request, _reply) => {
    const view = normalizeProxyLogsView(request.query.view);
    if (view === 'query') {
      return loadProxyLogsQueryPayload(request.query);
    }
    if (view === 'meta') {
      return loadProxyLogsMetaPayload(request.query);
    }
    const [queryPayload, metaPayload] = await Promise.all([
      loadProxyLogsQueryPayload(request.query),
      loadProxyLogsMetaPayload(request.query),
    ]);
    return {
      ...queryPayload,
      clientOptions: metaPayload.clientOptions,
      summary: metaPayload.summary,
      sites: metaPayload.sites,
      models: metaPayload.models,
    };
  });

  app.route({
    method: ['GET', 'POST'],
    url: '/api/stats/proxy-logs/stream',
    handler: async (request, reply) => {
    const raw = reply.raw;
    const acceptHeader = String(request.headers.accept || '');
    if (!acceptHeader.includes('text/event-stream') && acceptHeader !== '*/*') {
      // Return the reply instead of falling through with undefined: the handler
      // promise then stays pending until the 406 has flushed, so the onSend
      // chain (suspended on the async capability/security hooks) never restarts.
      return reply.code(406).send({ message: 'This endpoint requires text/event-stream' });
    }

    reply.hijack();
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const write = (payload: string): boolean => {
      if (raw.destroyed || raw.writableEnded) return false;
      try {
        raw.write(payload);
        return true;
      } catch {
        return false;
      }
    };

    write(': connected\n\n');

    const heartbeat = setInterval(() => {
      if (!write(': keepalive\n\n')) cleanup();
    }, 30_000);

    const onLog = (event: ProxyLogEvent) => {
      if (!write(`data: ${JSON.stringify(event)}\n\n`)) cleanup();
    };

    proxyLogEventBus.on('proxy-log:created', onLog);

    const cleanup = () => {
      clearInterval(heartbeat);
      proxyLogEventBus.off('proxy-log:created', onLog);
    };

    raw.on('close', cleanup);
    raw.on('error', cleanup);
    },
  });

  app.get<{ Params: { id: string } }>(
    '/api/stats/proxy-logs/:id',
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return reply.code(400).send({ message: 'proxy log id is invalid' });
      }

      const row = (await withProxyLogSelectFields(
        ({ fields }) =>
          db
            .select({
              proxy_logs: fields,
              accounts: schema.accounts,
              sites: schema.sites,
              downstream_api_keys: {
                id: schema.downstreamApiKeys.id,
                name: schema.downstreamApiKeys.name,
                groupName: schema.downstreamApiKeys.groupName,
                tags: schema.downstreamApiKeys.tags,
              },
            })
            .from(schema.proxyLogs)
            .leftJoin(
              schema.accounts,
              eq(schema.proxyLogs.accountId, schema.accounts.id),
            )
            .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
            .leftJoin(
              schema.downstreamApiKeys,
              eq(
                schema.proxyLogs.downstreamApiKeyId,
                schema.downstreamApiKeys.id,
              ),
            )
            .where(eq(schema.proxyLogs.id, id))
            .get(),
        { includeBillingDetails: true },
      )) as
        | {
            proxy_logs: Record<string, unknown> & {
              billingDetails?: string | null;
            };
            accounts: { username?: string | null } | null;
            sites: {
              id?: number | null;
              name?: string | null;
              url?: string | null;
            } | null;
            downstream_api_keys: {
              id?: number | null;
              name?: string | null;
              groupName?: string | null;
              tags?: string | null;
            } | null;
          }
        | undefined;

      if (!row) {
        return reply.code(404).send({ message: 'proxy log not found' });
      }

      return mapProxyLogRow(row, { includeBillingDetails: true });
    },
  );
}
