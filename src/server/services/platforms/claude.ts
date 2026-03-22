import { StandardApiProviderAdapterBase } from './standardApiProvider.js';

const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

export class ClaudeAdapter extends StandardApiProviderAdapterBase {
  readonly platformName = 'claude';

  async detect(url: string): Promise<boolean> {
    const normalized = (url || '').toLowerCase();
    return normalized.includes('api.anthropic.com') || normalized.includes('anthropic.com/v1');
  }

  async getModels(baseUrl: string, apiToken: string): Promise<string[]> {
    return this.fetchModelsFromStandardEndpoint({
      baseUrl,
      headers: {
        'x-api-key': apiToken,
        'anthropic-version': DEFAULT_ANTHROPIC_VERSION,
      },
    });
  }
}
