import {
  rankConversationFileEndpoints,
  type ConversationFileInputSummary,
} from '../proxy-core/capabilities/conversationFileCapabilities.js';
import type { UpstreamEndpoint } from '../proxy-core/orchestration/upstreamRequest.js';
import { fetchModelPricingCatalog } from './modelPricingService.js';
import {
  applyUpstreamEndpointRuntimePreference,
  buildEndpointCapabilityProfile,
} from './upstreamEndpointRuntimeMemory.js';
import type { DownstreamFormat } from '../transformers/shared/normalized.js';
import { asTrimmedString } from '../shared/trimString.js';


export type EndpointPreference = DownstreamFormat | 'responses';
export type EndpointDerivationHints = {
  oauthProvider?: string | null;
  requestKind?: 'default' | 'responses-compact' | 'claude-count-tokens';
  requiresNativeResponsesFileUrl?: boolean;
};

type ChannelContext = {
  site: {
    id: number;
    url: string;
    platform: string;
    apiKey?: string | null;
    customHeaders?: string | null;
    protocolProfile?: string | null;
  };
  account: {
    id: number;
    accessToken?: string | null;
    apiToken?: string | null;
  };
};

function normalizePlatformName(platform: unknown): string {
  return asTrimmedString(platform).toLowerCase();
}

function normalizeEndpointTypes(value: unknown): UpstreamEndpoint[] {
  const raw = asTrimmedString(value).toLowerCase();
  if (!raw) return [];

  const normalized = new Set<UpstreamEndpoint>();

  if (
    raw.includes('/v1/messages')
    || raw === 'messages'
    || raw.includes('anthropic')
    || raw.includes('claude')
  ) {
    normalized.add('messages');
  }

  if (
    raw.includes('/v1/responses')
    || raw === 'responses'
    || raw.includes('response')
  ) {
    normalized.add('responses');
  }

  if (
    raw.includes('/v1/chat/completions')
    || raw.includes('chat/completions')
    || raw === 'chat'
    || raw === 'chat_completions'
    || raw === 'completions'
    || raw.includes('chat')
  ) {
    normalized.add('chat');
  }

  if (raw === 'openai' || raw.includes('openai')) {
    normalized.add('chat');
    normalized.add('responses');
  }

  return Array.from(normalized);
}

function preferredEndpointOrder(
  sitePlatform?: string,
  modelName?: string,
  preferMessagesForClaudeModel = false,
  hints?: EndpointDerivationHints,
): UpstreamEndpoint[] {
  const platform = normalizePlatformName(sitePlatform);
  if (hints?.requestKind === 'responses-compact') {
    return ['responses'];
  }

  const oauthProvider = asTrimmedString(hints?.oauthProvider).toLowerCase();

  if (platform === 'codex') {
    return ['responses'];
  }

  // Grok CLI 上游是 OpenAI Responses API（9router grok-cli.js）
  if (platform === 'grok') {
    return ['responses'];
  }

  if (platform === 'gemini' || platform === 'gemini-cli') {
    return ['chat'];
  }

  if (platform === 'antigravity') {
    return ['messages'];
  }

  if (platform === 'claude') {
    return ['messages'];
  }

  if (oauthProvider === 'codex') {
    return ['responses', 'chat', 'messages'];
  }

  // The protocol face follows the model family, never a site-level switch:
  //   OpenAI/Codex family → /v1/responses   (the Codex-client face)
  //   Claude family       → /v1/messages    (the Claude Code face)
  //   everything else     → /v1/chat/completions (the universal face)
  // Runtime memory may still demote the leading face per model (and per
  // site) when the upstream only serves these models on another one, so a
  // relay with GPT on responses *and* GLM on chat serves both from the first
  // call without a site-wide lock.
  if (preferMessagesForClaudeModel) {
    return ['messages', 'chat', 'responses'];
  }
  if (isOpenAiFamilyModel(modelName)) {
    return ['responses', 'chat', 'messages'];
  }
  return ['chat', 'messages', 'responses'];
}

/**
 * OpenAI/Codex-family detection for endpoint ordering. These are the models a
 * Responses-native upstream serves on /v1/responses, so they lead with the
 * /v1/responses face. The leading face is never pinned: runtime endpoint
 * evidence (e.g. a 404 from an upstream that only serves chat) may demote it —
 * the same rule chat-only families follow (glm / gemini / deepseek / qwen …,
 * see new-api PR #5209).
 */
function isOpenAiFamilyModel(modelName?: string): boolean {
  const raw = asTrimmedString(modelName).toLowerCase();
  if (!raw) return false;
  const normalized = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  if (normalized.includes('claude')) return false;
  return normalized.includes('codex')
    || /(?:^|[-_.])gpt(?:[-_.]|$)/.test(normalized)
    || normalized.startsWith('chatgpt')
    || /^o[1-9](?:[-_.]|$)/.test(normalized);
}

export async function resolveUpstreamEndpointCandidates(
  context: ChannelContext,
  modelName: string,
  downstreamFormat: EndpointPreference,
  requestedModelHint?: string,
  requestCapabilities?: {
    hasNonImageFileInput?: boolean;
    conversationFileSummary?: ConversationFileInputSummary;
    wantsNativeResponsesReasoning?: boolean;
    wantsContinuationAwareResponses?: boolean;
  },
  hints?: EndpointDerivationHints,
): Promise<UpstreamEndpoint[]> {
  const sitePlatform = normalizePlatformName(context.site.platform);
  if (hints?.requestKind === 'responses-compact') {
    return ['responses'];
  }
  if (
    hints?.requiresNativeResponsesFileUrl
    && sitePlatform !== 'claude'
  ) {
    return ['responses'];
  }

  const capabilityProfile = buildEndpointCapabilityProfile({
    modelName,
    requestedModelHint,
    requestCapabilities,
  });
  const preferMessagesForClaudeModel = capabilityProfile.preferMessagesForClaudeModel;
  const hasNonImageFileInput = capabilityProfile.hasNonImageFileInput;
  const wantsNativeResponsesReasoning = capabilityProfile.wantsNativeResponsesReasoning;
  const wantsContinuationAwareResponses = capabilityProfile.wantsContinuationAwareResponses;
  const applyRuntimePreference = (candidates: UpstreamEndpoint[]) => (
    applyUpstreamEndpointRuntimePreference(candidates, {
      siteId: context.site.id,
      downstreamFormat,
      capabilityProfile,
    })
  );
  const finalizeCandidates = (candidates: UpstreamEndpoint[]): UpstreamEndpoint[] => {
    const preferredCandidates = applyRuntimePreference(candidates);
    if (hints?.requestKind === 'claude-count-tokens') {
      return preferredCandidates.includes('messages') ? ['messages'] : ([] as UpstreamEndpoint[]);
    }
    return preferredCandidates;
  };
  const conversationFileSummary = requestCapabilities?.conversationFileSummary ?? {
    hasImage: false,
    hasAudio: false,
    hasDocument: hasNonImageFileInput,
    hasRemoteDocumentUrl: false,
  };

  const preferred = preferredEndpointOrder(
    context.site.platform,
    modelName,
    preferMessagesForClaudeModel,
    hints,
  );
  const preferredWithCapabilities = hasNonImageFileInput
    ? (() => {
      if (sitePlatform === 'claude') return ['messages'] as UpstreamEndpoint[];
      if (sitePlatform === 'gemini') return ['responses', 'chat'] as UpstreamEndpoint[];
      if (sitePlatform === 'gemini-cli') return ['chat'] as UpstreamEndpoint[];
      if (sitePlatform === 'antigravity') return ['messages'] as UpstreamEndpoint[];
      // Documents only exist natively on the Responses face for OpenAI-class
      // upstreams (never on plain chat): Responses leads, messages/chat remain
      // downgrade fallbacks.
      if (sitePlatform === 'openai') return ['responses', 'messages', 'chat'] as UpstreamEndpoint[];
      return rankConversationFileEndpoints({
        sitePlatform,
        requestedOrder: preferMessagesForClaudeModel
          ? ['messages', 'responses', 'chat']
          : ['responses', 'messages', 'chat'],
        summary: conversationFileSummary,
        preferMessagesForClaudeModel,
      });
    })()
    : preferred;
  const prioritizedPreferredEndpoints: UpstreamEndpoint[] = (
    preferredWithCapabilities.includes('responses')
    && (
      wantsContinuationAwareResponses
      || (wantsNativeResponsesReasoning && preferMessagesForClaudeModel)
    )
  )
    ? [
      'responses',
      ...preferredWithCapabilities.filter((endpoint): endpoint is UpstreamEndpoint => endpoint !== 'responses'),
    ]
    : preferredWithCapabilities;
  const forceMessagesFirstForClaudeModel = (
    downstreamFormat === 'openai'
    && preferMessagesForClaudeModel
    && sitePlatform !== 'openai'
    && sitePlatform !== 'gemini'
    && sitePlatform !== 'antigravity'
    && sitePlatform !== 'gemini-cli'
  );

  try {
    const catalog = await fetchModelPricingCatalog({
      site: {
        id: context.site.id,
        url: context.site.url,
        platform: context.site.platform,
      },
      account: {
        id: context.account.id,
        accessToken: context.account.accessToken ?? null,
        apiToken: context.account.apiToken ?? null,
      },
      modelName,
      totalTokens: 0,
    });

    if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) {
      return finalizeCandidates(prioritizedPreferredEndpoints);
    }

    const matched = catalog.models.find((item) =>
      asTrimmedString(item?.modelName).toLowerCase() === modelName.toLowerCase(),
    );
    if (!matched) return finalizeCandidates(prioritizedPreferredEndpoints);

    const shouldIgnoreCatalogOrderingForClaudeMessages = (
      preferMessagesForClaudeModel
      && (downstreamFormat !== 'responses' || sitePlatform !== 'openai')
    );
    if (shouldIgnoreCatalogOrderingForClaudeMessages) {
      return finalizeCandidates(prioritizedPreferredEndpoints);
    }

    const supportedRaw = Array.isArray(matched.supportedEndpointTypes) ? matched.supportedEndpointTypes : [];
    const normalizedSupportedRaw = supportedRaw
      .map((item) => asTrimmedString(item).toLowerCase())
      .filter((item) => item.length > 0);
    const hasConcreteEndpointHint = normalizedSupportedRaw.some((raw) => (
      raw.includes('/v1/messages')
      || raw.includes('/v1/chat/completions')
      || raw.includes('/v1/responses')
      || raw === 'messages'
      || raw === 'chat'
      || raw === 'chat_completions'
      || raw === 'completions'
      || raw === 'responses'
    ));
    if (forceMessagesFirstForClaudeModel && !hasConcreteEndpointHint) {
      return finalizeCandidates(prioritizedPreferredEndpoints);
    }

    const supported = new Set<UpstreamEndpoint>();
    for (const endpoint of supportedRaw) {
      const normalizedList = normalizeEndpointTypes(endpoint);
      for (const normalized of normalizedList) {
        supported.add(normalized);
      }
    }

    if (supported.size === 0) return finalizeCandidates(prioritizedPreferredEndpoints);

    const firstSupported = prioritizedPreferredEndpoints.find((endpoint) => supported.has(endpoint));
    if (!firstSupported) return finalizeCandidates(prioritizedPreferredEndpoints);

    return finalizeCandidates([
      firstSupported,
      ...prioritizedPreferredEndpoints.filter((endpoint) => endpoint !== firstSupported),
    ]);
  } catch {
    return finalizeCandidates(prioritizedPreferredEndpoints);
  }
}
