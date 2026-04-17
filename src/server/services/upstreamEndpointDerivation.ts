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
  };
  account: {
    id: number;
    accessToken?: string | null;
    apiToken?: string | null;
  };
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

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
  downstreamFormat: EndpointPreference,
  sitePlatform?: string,
  preferMessagesForClaudeModel = false,
  hints?: EndpointDerivationHints,
): UpstreamEndpoint[] {
  const platform = normalizePlatformName(sitePlatform);
  const oauthProvider = asTrimmedString(hints?.oauthProvider).toLowerCase();

  if (hints?.requestKind === 'responses-compact') {
    return ['responses'];
  }

  if (platform === 'codex') {
    return ['responses'];
  }

  if (platform === 'gemini' || platform === 'gemini-cli') {
    return ['chat'];
  }

  if (platform === 'openai') {
    return ['responses', 'chat', 'messages'];
  }

  if (platform === 'antigravity') {
    return ['messages'];
  }

  if (platform === 'claude') {
    return ['messages'];
  }

  if (downstreamFormat === 'responses') {
    if (preferMessagesForClaudeModel) {
      return ['messages', 'chat', 'responses'];
    }
    return ['responses', 'chat', 'messages'];
  }

  if (downstreamFormat === 'claude') {
    return ['messages', 'chat', 'responses'];
  }

  if (downstreamFormat === 'openai' && preferMessagesForClaudeModel) {
    return ['messages', 'chat', 'responses'];
  }

  const base = ['chat', 'messages', 'responses'] as UpstreamEndpoint[];
  if (oauthProvider === 'codex' && base.includes('responses')) {
    return ['responses', ...base.filter((endpoint) => endpoint !== 'responses')];
  }

  return base;
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
    && sitePlatform !== 'anyrouter'
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

  if (sitePlatform === 'anyrouter') {
    if (hasNonImageFileInput) {
      return finalizeCandidates(downstreamFormat === 'responses'
        ? ['responses', 'messages', 'chat']
        : ['messages', 'responses', 'chat']);
    }
    if (downstreamFormat === 'responses') {
      return finalizeCandidates(['responses', 'messages', 'chat']);
    }
    return finalizeCandidates(['messages', 'chat', 'responses']);
  }

  const preferred = preferredEndpointOrder(
    downstreamFormat,
    context.site.platform,
    preferMessagesForClaudeModel,
    hints,
  );
  const preferredWithCapabilities = hasNonImageFileInput
    ? (() => {
      if (sitePlatform === 'claude') return ['messages'] as UpstreamEndpoint[];
      if (sitePlatform === 'gemini') return ['responses', 'chat'] as UpstreamEndpoint[];
      if (sitePlatform === 'gemini-cli') return ['chat'] as UpstreamEndpoint[];
      if (sitePlatform === 'antigravity') return ['messages'] as UpstreamEndpoint[];
      if (sitePlatform === 'openai') return ['responses', 'chat', 'messages'] as UpstreamEndpoint[];
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
