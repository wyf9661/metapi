import {geminiGenerateContentResponseBridge} from './responseBridge.js';
export const geminiGenerateContentOutbound = geminiGenerateContentResponseBridge;

export {
  geminiGenerateContentResponseBridge,
  extractGeminiGenerateContentResponseMetadata as extractResponseMetadata,
  extractGeminiGenerateContentTransformerMetadata as extractTransformerMetadata,
  serializeGeminiGenerateContentAggregateResponse as serializeGeminiAggregateResponse,
} from './responseBridge.js';
