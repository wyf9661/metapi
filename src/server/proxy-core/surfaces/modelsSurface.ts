import {
  buildModelsSurfaceCacheKey,
  readModelsSurfaceCache,
  runModelsSurfaceCompute,
  writeModelsSurfaceCache,
} from '../../services/modelsSurfaceCache.js';

function isSearchPseudoModel(modelName: string): boolean {
  const normalized = (modelName || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized === '__search' || /^__.+_search$/.test(normalized);
}

type ModelsSurfaceInput = {
  downstreamPolicy: unknown;
  responseFormat: 'openai' | 'claude';
  tokenRouter: {
    getAvailableModels(): Promise<string[]>;
    explainSelection(modelName: string, excludeChannelIds: number[], downstreamPolicy: unknown): Promise<{
      selectedChannelId?: number | null;
    }>;
  };
  refreshModelsAndRebuildRoutes(): Promise<unknown>;
  isModelAllowed(modelName: string, downstreamPolicy: unknown): Promise<boolean>;
  now?: () => Date;
};

async function readVisibleModels(input: ModelsSurfaceInput): Promise<string[]> {
  const deduped = Array.from(new Set(await input.tokenRouter.getAvailableModels()))
    .filter((modelName) => !isSearchPseudoModel(modelName))
    .sort();
  const allowed: string[] = [];
  for (const modelName of deduped) {
    if (!await input.isModelAllowed(modelName, input.downstreamPolicy)) {
      continue;
    }
    const decision = await input.tokenRouter.explainSelection(modelName, [], input.downstreamPolicy);
    if (typeof decision.selectedChannelId === 'number') {
      allowed.push(modelName);
    }
  }
  return allowed;
}

// The visible-model list re-decides routing for every exposed model — per-request
// work that clients poll on short fuses (listing probes with 5s timeouts). Cache
// the model-id list per (response format, downstream policy) with a short TTL and
// single-flight compute; the response envelope (including `created` timestamps)
// is still rendered fresh from `now` on every call. Empty lists are never cached,
// so the refresh-and-reread recovery below keeps running on that path.
export async function listModelsSurface(input: ModelsSurfaceInput) {
  const cacheKey = buildModelsSurfaceCacheKey(input.responseFormat, input.downstreamPolicy);
  let models = readModelsSurfaceCache(cacheKey, Date.now());
  if (!models) {
    models = await runModelsSurfaceCompute(cacheKey, async () => {
      let computed = await readVisibleModels(input);
      if (computed.length === 0) {
        await input.refreshModelsAndRebuildRoutes();
        computed = await readVisibleModels(input);
      }
      writeModelsSurfaceCache(cacheKey, computed, Date.now());
      return computed;
    });
  }

  const now = input.now?.() ?? new Date();
  if (input.responseFormat === 'claude') {
    const data = models.map((id) => ({
      id,
      type: 'model' as const,
      display_name: id,
      created_at: now.toISOString(),
    }));
    return {
      data,
      first_id: data[0]?.id || null,
      last_id: data[data.length - 1]?.id || null,
      has_more: false,
    };
  }

  return {
    object: 'list' as const,
    data: models.map((id) => ({
      id,
      object: 'model' as const,
      created: Math.floor(now.getTime() / 1000),
      owned_by: 'metapi',
    })),
  };
}
