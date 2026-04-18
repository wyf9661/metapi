import {
  buildMinimalJsonHeadersForCompatibility,
  isEndpointDispatchDeniedError,
  isEndpointDowngradeError,
  isUnsupportedMediaTypeError,
  promoteResponsesCandidateAfterLegacyChatError,
  shouldPreferResponsesAfterLegacyChatError,
} from '../../transformers/shared/endpointCompatibility.js';

export {
  buildMinimalJsonHeadersForCompatibility,
  isEndpointDispatchDeniedError,
  isEndpointDowngradeError,
  isUnsupportedMediaTypeError,
  promoteResponsesCandidateAfterLegacyChatError,
  shouldPreferResponsesAfterLegacyChatError,
};

export type { UpstreamEndpoint } from '../../proxy-core/orchestration/upstreamRequest.js';
export {
  buildClaudeCountTokensUpstreamRequest,
  buildUpstreamEndpointRequest,
} from '../../services/upstreamRequestBuilder.js';
export { resolveUpstreamEndpointCandidates } from '../../services/upstreamEndpointDerivation.js';
export type {
  EndpointDerivationHints,
  EndpointPreference,
} from '../../services/upstreamEndpointDerivation.js';
