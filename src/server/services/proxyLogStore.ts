import { and, eq } from 'drizzle-orm';
import {
  db,
  schema,
  hasProxyLogBillingDetailsColumn,
  hasProxyLogCacheTokensColumns,
  hasProxyLogClientColumns,
  hasProxyLogReasoningEffortColumn,
  hasProxyLogDownstreamApiKeyIdColumn,
  hasProxyLogStreamTimingColumns,
  hasProxyLogRequestTraceIdColumn,
} from '../db/index.js';
import { canonicalizeModelName } from '../shared/modelCanonicalization.js';
import { emitProxyLogCreated } from './proxyLogEventBus.js';
import { getCurrentReasoningEffort } from './reasoningEffort.js';

export type ProxyLogInsertInput = {
  routeId?: number | null;
  channelId?: number | null;
  accountId?: number | null;
  downstreamApiKeyId?: number | null;
  modelRequested?: string | null;
  modelActual?: string | null;
  status?: string | null;
  httpStatus?: number | null;
  isStream?: boolean | null;
  firstByteLatencyMs?: number | null;
  latencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  reasoningEffort?: string | null;
  estimatedCost?: number | null;
  billingDetails?: unknown;
  clientFamily?: string | null;
  clientAppId?: string | null;
  clientAppName?: string | null;
  clientConfidence?: string | null;
  errorMessage?: string | null;
  requestTraceId?: string | null;
  retryCount?: number | null;
  createdAt?: string | null;
};

function buildProxyLogCoreSelectFields() {
  return {
    id: schema.proxyLogs.id,
    routeId: schema.proxyLogs.routeId,
    channelId: schema.proxyLogs.channelId,
    accountId: schema.proxyLogs.accountId,
    downstreamApiKeyId: schema.proxyLogs.downstreamApiKeyId,
    modelRequested: schema.proxyLogs.modelRequested,
    modelActual: schema.proxyLogs.modelActual,
    status: schema.proxyLogs.status,
    httpStatus: schema.proxyLogs.httpStatus,
    latencyMs: schema.proxyLogs.latencyMs,
    promptTokens: schema.proxyLogs.promptTokens,
    completionTokens: schema.proxyLogs.completionTokens,
    totalTokens: schema.proxyLogs.totalTokens,
    estimatedCost: schema.proxyLogs.estimatedCost,
    errorMessage: schema.proxyLogs.errorMessage,
    retryCount: schema.proxyLogs.retryCount,
    createdAt: schema.proxyLogs.createdAt,
  };
}

function buildProxyLogClientSelectFields() {
  return {
    clientFamily: schema.proxyLogs.clientFamily,
    clientAppId: schema.proxyLogs.clientAppId,
    clientAppName: schema.proxyLogs.clientAppName,
    clientConfidence: schema.proxyLogs.clientConfidence,
  };
}

function buildProxyLogStreamTimingSelectFields() {
  return {
    isStream: schema.proxyLogs.isStream,
    firstByteLatencyMs: schema.proxyLogs.firstByteLatencyMs,
  };
}

function buildProxyLogRequestTraceSelectFields() {
  return {
    requestTraceId: schema.proxyLogs.requestTraceId,
  };
}

function buildProxyLogSelectFields(options?: {
  includeBillingDetails?: boolean;
  includeCacheTokens?: boolean;
  includeClientFields?: boolean;
  includeStreamTimingFields?: boolean;
  includeRequestTraceId?: boolean;
}) {
  return {
    ...buildProxyLogCoreSelectFields(),
    ...(options?.includeCacheTokens ? {
      cacheReadTokens: schema.proxyLogs.cacheReadTokens,
      cacheCreationTokens: schema.proxyLogs.cacheCreationTokens,
      reasoningEffort: schema.proxyLogs.reasoningEffort,
    } : {}),
    ...(options?.includeStreamTimingFields ? buildProxyLogStreamTimingSelectFields() : {}),
    ...(options?.includeClientFields ? buildProxyLogClientSelectFields() : {}),
    ...(options?.includeBillingDetails ? { billingDetails: schema.proxyLogs.billingDetails } : {}),
    ...(options?.includeRequestTraceId ? buildProxyLogRequestTraceSelectFields() : {}),
  };
}

export function getProxyLogBaseSelectFields() {
  return buildProxyLogCoreSelectFields();
}

export type ProxyLogSelectFields = ReturnType<typeof buildProxyLogSelectFields>;

export type ResolvedProxyLogSelectFields = {
  includeBillingDetails: boolean;
  includeCacheTokens: boolean;
  includeClientFields: boolean;
  includeStreamTimingFields: boolean;
  includeRequestTraceId: boolean;
  fields: ProxyLogSelectFields;
};

export async function resolveProxyLogSelectFields(options?: {
  includeBillingDetails?: boolean;
  includeCacheTokens?: boolean;
  includeClientFields?: boolean;
  includeStreamTimingFields?: boolean;
  includeRequestTraceId?: boolean;
}) {
  const includeBillingDetails = options?.includeBillingDetails === true
    && await hasProxyLogBillingDetailsColumn();
  const includeCacheTokens = options?.includeCacheTokens !== false
    && await hasProxyLogCacheTokensColumns();
  const includeClientFields = options?.includeClientFields !== false
    && await hasProxyLogClientColumns();
  const includeStreamTimingFields = options?.includeStreamTimingFields !== false
    && await hasProxyLogStreamTimingColumns();
  const includeRequestTraceId = options?.includeRequestTraceId !== false
    && await hasProxyLogRequestTraceIdColumn();

  return {
    includeBillingDetails,
    includeCacheTokens,
    includeClientFields,
    includeStreamTimingFields,
    includeRequestTraceId,
    fields: buildProxyLogSelectFields({
      includeBillingDetails,
      includeCacheTokens,
      includeClientFields,
      includeStreamTimingFields,
      includeRequestTraceId,
    }),
  };
}

export async function withProxyLogSelectFields<T>(
  runner: (selection: ResolvedProxyLogSelectFields) => Promise<T>,
  options?: {
    includeBillingDetails?: boolean;
    includeCacheTokens?: boolean;
    includeClientFields?: boolean;
    includeStreamTimingFields?: boolean;
    includeRequestTraceId?: boolean;
  },
): Promise<T> {
  let selection = await resolveProxyLogSelectFields(options);

  while (true) {
    try {
      return await runner(selection);
    } catch (error) {
      if (selection.includeBillingDetails && isMissingBillingDetailsColumnError(error)) {
        selection = {
          includeBillingDetails: false,
          includeCacheTokens: selection.includeCacheTokens,
          includeClientFields: selection.includeClientFields,
          includeStreamTimingFields: selection.includeStreamTimingFields,
          includeRequestTraceId: selection.includeRequestTraceId,
          fields: buildProxyLogSelectFields({
            includeBillingDetails: false,
            includeCacheTokens: selection.includeCacheTokens,
            includeClientFields: selection.includeClientFields,
            includeStreamTimingFields: selection.includeStreamTimingFields,
            includeRequestTraceId: selection.includeRequestTraceId,
          }),
        };
        continue;
      }

      if (selection.includeCacheTokens && isMissingProxyLogCacheTokensColumnsError(error)) {
        selection = {
          includeBillingDetails: selection.includeBillingDetails,
          includeCacheTokens: false,
          includeClientFields: selection.includeClientFields,
          includeStreamTimingFields: selection.includeStreamTimingFields,
          includeRequestTraceId: selection.includeRequestTraceId,
          fields: buildProxyLogSelectFields({
            includeBillingDetails: selection.includeBillingDetails,
            includeCacheTokens: false,
            includeClientFields: selection.includeClientFields,
            includeStreamTimingFields: selection.includeStreamTimingFields,
            includeRequestTraceId: selection.includeRequestTraceId,
          }),
        };
        continue;
      }

      if (selection.includeClientFields && isMissingProxyLogClientColumnsError(error)) {
        selection = {
          includeBillingDetails: selection.includeBillingDetails,
          includeCacheTokens: selection.includeCacheTokens,
          includeClientFields: false,
          includeStreamTimingFields: selection.includeStreamTimingFields,
          includeRequestTraceId: selection.includeRequestTraceId,
          fields: buildProxyLogSelectFields({
            includeBillingDetails: selection.includeBillingDetails,
            includeCacheTokens: selection.includeCacheTokens,
            includeClientFields: false,
            includeStreamTimingFields: selection.includeStreamTimingFields,
            includeRequestTraceId: selection.includeRequestTraceId,
          }),
        };
        continue;
      }

      if (selection.includeStreamTimingFields && isMissingProxyLogStreamTimingColumnsError(error)) {
        selection = {
          includeBillingDetails: selection.includeBillingDetails,
          includeCacheTokens: selection.includeCacheTokens,
          includeClientFields: selection.includeClientFields,
          includeStreamTimingFields: false,
          includeRequestTraceId: selection.includeRequestTraceId,
          fields: buildProxyLogSelectFields({
            includeBillingDetails: selection.includeBillingDetails,
            includeCacheTokens: selection.includeCacheTokens,
            includeClientFields: selection.includeClientFields,
            includeStreamTimingFields: false,
            includeRequestTraceId: selection.includeRequestTraceId,
          }),
        };
        continue;
      }

      if (selection.includeRequestTraceId && isMissingProxyLogRequestTraceIdColumnError(error)) {
        selection = {
          includeBillingDetails: selection.includeBillingDetails,
          includeCacheTokens: selection.includeCacheTokens,
          includeClientFields: selection.includeClientFields,
          includeStreamTimingFields: selection.includeStreamTimingFields,
          includeRequestTraceId: false,
          fields: buildProxyLogSelectFields({
            includeBillingDetails: selection.includeBillingDetails,
            includeCacheTokens: selection.includeCacheTokens,
            includeClientFields: selection.includeClientFields,
            includeStreamTimingFields: selection.includeStreamTimingFields,
            includeRequestTraceId: false,
          }),
        };
        continue;
      }

      throw error;
    }
  }
}

export function parseProxyLogBillingDetails(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function toNonNegativeIntOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

function normalizeProxyLogStoreErrorMessage(error: unknown): string {
  const message = typeof error === 'object' && error && 'message' in error
    ? String((error as { message?: unknown }).message || '')
    : String(error || '');
  return message.toLowerCase();
}

export function isMissingBillingDetailsColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('billing_details')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogCacheTokensColumnsError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('cache_read_tokens')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogReasoningEffortColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('reasoning_effort')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingDownstreamApiKeyIdColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('downstream_api_key_id')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogClientColumnsError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  const hasClientColumnReference = [
    'client_family',
    'client_app_id',
    'client_app_name',
    'client_confidence',
  ].some((columnName) => lowered.includes(columnName));

  return hasClientColumnReference
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogStreamTimingColumnsError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  const hasStreamTimingColumnReference = [
    'is_stream',
    'first_byte_latency_ms',
  ].some((columnName) => lowered.includes(columnName));

  return hasStreamTimingColumnReference
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogRequestTraceIdColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('request_trace_id')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}


async function updateModelConnectivityFromProxyLog(input: ProxyLogInsertInput): Promise<void> {
  const accountId = Number(input.accountId);
  if (!Number.isFinite(accountId) || accountId <= 0) return;

  const status = String(input.status || '').toLowerCase();
  if (status !== 'success' && status !== 'failed') return;

  const modelName = String(input.modelActual || input.modelRequested || '').trim();
  if (!modelName) return;

  const available = status === 'success';
  const latencyMs = typeof input.latencyMs === 'number' && Number.isFinite(input.latencyMs)
    ? Math.max(0, Math.round(input.latencyMs))
    : null;
  const checkedAt = input.createdAt || new Date().toISOString();

  try {
    const existing = await db.select({ id: schema.modelAvailability.id })
      .from(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, accountId),
        eq(schema.modelAvailability.modelName, modelName),
      ))
      .get();

    if (existing?.id) {
      await db.update(schema.modelAvailability)
        .set({
          connectivity: available,
          ...(latencyMs != null ? { latencyMs } : {}),
          checkedAt,
        })
        .where(eq(schema.modelAvailability.id, existing.id))
        .run();
      return;
    }

    // Create listing + connectivity only when traffic proves the model works.
    if (available) {
      await db.insert(schema.modelAvailability).values({
        accountId,
        modelName,
        available: true,
        connectivity: true,
        latencyMs,
        checkedAt,
      }).run();
    }
  } catch {
    // best-effort; never break proxy logging
  }
}

export async function insertProxyLog(input: ProxyLogInsertInput): Promise<void> {
  // Normalize the downstream-requested model name so provider prefixes
  // (e.g. "mimo/mimo-v2.5") and free/date aliases are collapsed to the
  // canonical key before persisting. model_actual keeps its raw upstream
  // name because that is what the channel forwards to the provider.
  const modelRequested = input.modelRequested
    ? (canonicalizeModelName(input.modelRequested) || input.modelRequested)
    : null;
  const baseValues = {
    routeId: input.routeId ?? null,
    channelId: input.channelId ?? null,
    accountId: input.accountId ?? null,
    modelRequested,
    modelActual: input.modelActual ?? null,
    status: input.status ?? null,
    httpStatus: input.httpStatus ?? null,
    latencyMs: input.latencyMs ?? null,
    promptTokens: input.promptTokens ?? null,
    completionTokens: input.completionTokens ?? null,
    totalTokens: input.totalTokens ?? null,
    estimatedCost: input.estimatedCost ?? 0,
    errorMessage: input.errorMessage ?? null,
    retryCount: input.retryCount ?? 0,
    createdAt: input.createdAt ?? null,
  };
  const serializedBillingDetails = input.billingDetails == null
    ? null
    : JSON.stringify(input.billingDetails);
  const includeBillingDetails = serializedBillingDetails !== null
    && await hasProxyLogBillingDetailsColumn();
  // Cache split: prefer an explicit value, otherwise lift it from the billing
  // details the proxy surfaces already record (usage.cacheReadTokens /
  // cacheCreationTokens), so the usage log list can show real input without
  // threading the value through every record call site.
  const billingUsage = (input.billingDetails as {
    usage?: { cacheReadTokens?: unknown; cacheCreationTokens?: unknown };
  } | null | undefined)?.usage;
  const cacheReadTokens = input.cacheReadTokens ?? toNonNegativeIntOrNull(billingUsage?.cacheReadTokens);
  const cacheCreationTokens = input.cacheCreationTokens ?? toNonNegativeIntOrNull(billingUsage?.cacheCreationTokens);
  // Reasoning effort: an explicit value wins, otherwise use whatever the proxy
  // router captured for this request (chat: reasoning_effort, responses:
  // reasoning.effort).
  const reasoningEffort = input.reasoningEffort ?? getCurrentReasoningEffort();
  const requestedCacheTokens = cacheReadTokens != null || cacheCreationTokens != null;
  const includeCacheTokens = requestedCacheTokens
    && await hasProxyLogCacheTokensColumns();
  const includeDownstreamApiKeyId = input.downstreamApiKeyId != null
    && await hasProxyLogDownstreamApiKeyIdColumn();
  const requestedClientFields = [
    input.clientFamily,
    input.clientAppId,
    input.clientAppName,
    input.clientConfidence,
  ].some((value) => value != null && String(value).trim().length > 0);
  const includeClientFields = requestedClientFields
    && await hasProxyLogClientColumns();
  const requestedStreamTimingFields = input.isStream != null || input.firstByteLatencyMs != null;
  const includeStreamTimingFields = requestedStreamTimingFields
    && await hasProxyLogStreamTimingColumns();
  const includeRequestTraceId = Boolean(input.requestTraceId && String(input.requestTraceId).trim())
    && await hasProxyLogRequestTraceIdColumn();

  let allowBillingDetails = includeBillingDetails;
  let allowCacheTokens = includeCacheTokens;
  let allowReasoningEffort = reasoningEffort != null && await hasProxyLogReasoningEffortColumn();
  let allowDownstreamApiKeyId = includeDownstreamApiKeyId;
  let allowClientFields = includeClientFields;
  let allowStreamTimingFields = includeStreamTimingFields;
  let allowRequestTraceId = includeRequestTraceId;

  while (true) {
    const values = {
      ...baseValues,
      ...(allowRequestTraceId
        ? { requestTraceId: input.requestTraceId ?? null }
        : {}),
      ...(allowStreamTimingFields
        ? {
          isStream: input.isStream ?? null,
          firstByteLatencyMs: input.firstByteLatencyMs ?? null,
        }
        : {}),
      ...(allowBillingDetails ? { billingDetails: serializedBillingDetails } : {}),
      ...(allowCacheTokens
        ? {
          cacheReadTokens,
          cacheCreationTokens,
        }
        : {}),
      ...(allowReasoningEffort ? { reasoningEffort } : {}),
      ...(allowDownstreamApiKeyId ? { downstreamApiKeyId: input.downstreamApiKeyId } : {}),
      ...(allowClientFields
        ? {
          clientFamily: input.clientFamily ?? null,
          clientAppId: input.clientAppId ?? null,
          clientAppName: input.clientAppName ?? null,
          clientConfidence: input.clientConfidence ?? null,
        }
        : {}),
    };

    try {
      await db.insert(schema.proxyLogs).values(values).run();
      void updateModelConnectivityFromProxyLog(input);
      emitProxyLogCreated({
        id: 0,
        siteId: null,
        modelRequested: input.modelRequested ?? null,
        status: input.status ?? null,
        createdAt: input.createdAt ?? null,
      });
      return;
    } catch (error) {
      if (allowBillingDetails && isMissingBillingDetailsColumnError(error)) {
        allowBillingDetails = false;
        continue;
      }

      if (allowReasoningEffort && isMissingProxyLogReasoningEffortColumnError(error)) {
        allowReasoningEffort = false;
        continue;
      }

      if (allowCacheTokens && isMissingProxyLogCacheTokensColumnsError(error)) {
        allowCacheTokens = false;
        continue;
      }

      if (allowDownstreamApiKeyId && isMissingDownstreamApiKeyIdColumnError(error)) {
        allowDownstreamApiKeyId = false;
        continue;
      }

      if (allowClientFields && isMissingProxyLogClientColumnsError(error)) {
        allowClientFields = false;
        continue;
      }

      if (allowStreamTimingFields && isMissingProxyLogStreamTimingColumnsError(error)) {
        allowStreamTimingFields = false;
        continue;
      }

      if (allowRequestTraceId && isMissingProxyLogRequestTraceIdColumnError(error)) {
        allowRequestTraceId = false;
        continue;
      }

      throw error;
    }
  }
}
