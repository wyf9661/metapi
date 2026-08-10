/**
 * Model capabilities table synced from models.dev official catalog.
 *
 * Companion to modelPriceCatalogService: the same api.json payload also
 * describes each model's input/output modalities, reasoning support, tool
 * calling and token limits. This module parses those fields into a compact
 * capability record and serves lookups with a safe default floor, so
 * consumers never need null-checks (mirrors 9router's capabilities design:
 *   PROVIDER[model] > exact id > date-stripped id > DEFAULT floor).
 *
 * Data source: https://models.dev/api.json (sst/models.dev, MIT-licensed).
 * Field mapping (verified 2026-08-10):
 *   modalities.input  ["text","image","pdf","audio","video"] -> vision / pdf / audioInput / videoInput
 *   modalities.output ["text","image","audio"]              -> imageOutput / audioOutput
 *   reasoning   (bool) -> reasoning
 *   tool_call   (bool) -> tools
 *   limit.context / limit.output -> contextWindow / maxOutput
 * NOTE: models.dev has NO `search` flag (web search is a runtime tool, not a
 * model spec); `search` stays false unless set by a future vendor-docs source.
 */
import { normalizeModelName, stripDateSuffix } from './modelPriceCatalogService.js';

export interface ModelsDevCapabilities {
  // input modalities
  vision: boolean;
  pdf: boolean;
  audioInput: boolean;
  videoInput: boolean;
  // output modalities
  imageOutput: boolean;
  audioOutput: boolean;
  // features
  search: boolean; // not in models.dev; false unless a vendor-docs source fills it
  tools: boolean;
  reasoning: boolean;
  // token limits
  contextWindow: number;
  maxOutput: number;
}

/**
 * Safe floor — every resolved record is merged over this so consumers never
 * need null-checks. Most modern LLMs meet these limits.
 */
export const DEFAULT_CAPABILITIES: ModelsDevCapabilities = {
  vision: false,
  pdf: false,
  audioInput: false,
  videoInput: false,
  imageOutput: false,
  audioOutput: false,
  search: false,
  tools: true,
  reasoning: false,
  contextWindow: 200_000,
  maxOutput: 64_000,
};

const MAX_MEMORY_MODELS = 50_000; // hard cap against an unexpectedly huge payload

let modelsDevCapabilities = new Map<string, ModelsDevCapabilities>();

/** Parse one models.dev model entry into a capability record. */
function parseCapabilities(entry: Record<string, unknown>): ModelsDevCapabilities {
  const caps: ModelsDevCapabilities = { ...DEFAULT_CAPABILITIES };

  const modalities = entry.modalities;
  if (modalities && typeof modalities === 'object') {
    const input = (modalities as Record<string, unknown>).input;
    if (Array.isArray(input)) {
      caps.vision = input.includes('image');
      caps.pdf = input.includes('pdf');
      caps.audioInput = input.includes('audio');
      caps.videoInput = input.includes('video');
    }
    const output = (modalities as Record<string, unknown>).output;
    if (Array.isArray(output)) {
      caps.imageOutput = output.includes('image');
      caps.audioOutput = output.includes('audio');
    }
  }

  if (typeof entry.reasoning === 'boolean') caps.reasoning = entry.reasoning;
  if (typeof entry.tool_call === 'boolean') caps.tools = entry.tool_call;

  const limit = entry.limit;
  if (limit && typeof limit === 'object') {
    const ctx = Number((limit as Record<string, unknown>).context);
    if (Number.isFinite(ctx) && ctx > 0) caps.contextWindow = ctx;
    const out = Number((limit as Record<string, unknown>).output);
    if (Number.isFinite(out) && out > 0) caps.maxOutput = out;
  }

  return caps;
}

/**
 * Parse the full models.dev api.json payload into a capability map keyed by
 * normalized model id (keep-first per id; capabilities are intrinsic model
 * properties, provider priority is irrelevant). Pure function for tests.
 */
export function parseModelsDevCapabilities(
  jsonText: string,
): Map<string, ModelsDevCapabilities> | null {
  let payload: unknown;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const result = new Map<string, ModelsDevCapabilities>();
  for (const value of Object.values(payload as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const models = (value as Record<string, unknown>).models;
    if (!models || typeof models !== 'object') continue;
    for (const [modelId, entry] of Object.entries(models as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      const normalized = normalizeModelName(String(modelId));
      if (!normalized) continue;
      if (!result.has(normalized)) {
        result.set(normalized, parseCapabilities(entry as Record<string, unknown>));
      }
    }
    if (result.size > MAX_MEMORY_MODELS) break;
  }

  return result;
}

/**
 * Look up a model's capabilities. Exact id first, then date-stripped id
 * (`gpt-4o-2024-08-06` → `gpt-4o`), then the DEFAULT floor — never null.
 */
export function lookupModelsDevCapabilities(modelName: string): ModelsDevCapabilities {
  const normalized = normalizeModelName(modelName);
  if (normalized) {
    const exact = modelsDevCapabilities.get(normalized);
    if (exact) return exact;

    const stripped = stripDateSuffix(normalized);
    if (stripped !== normalized) {
      const fromStripped = modelsDevCapabilities.get(stripped);
      if (fromStripped) return fromStripped;
    }
  }
  return DEFAULT_CAPABILITIES;
}

/** Replace the in-memory capability table (called by the price sync pass). */
export function setModelsDevCapabilities(map: Map<string, ModelsDevCapabilities>): void {
  modelsDevCapabilities = map;
}

export function getModelsDevCapabilityCount(): number {
  return modelsDevCapabilities.size;
}

/** Test-only: replace the in-memory capability table. */
export function __setModelsDevCapabilitiesForTests(
  map: Map<string, ModelsDevCapabilities>,
): void {
  modelsDevCapabilities = map;
}
