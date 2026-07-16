import { antigravityExecutor } from '../../proxy-core/executors/antigravityExecutor.js';
import { claudeExecutor } from '../../proxy-core/executors/claudeExecutor.js';
import { codexExecutor } from '../../proxy-core/executors/codexExecutor.js';
import { geminiCliExecutor } from '../../proxy-core/executors/geminiCliExecutor.js';
import type { RuntimeDispatchInput, RuntimeResponse } from '../../proxy-core/executors/types.js';

export async function dispatchRuntimeRequest(
  input: RuntimeDispatchInput,
): Promise<RuntimeResponse> {
  const executor = input.request.runtime?.executor || 'default';
  switch (executor) {
    case 'codex':
    case 'default':
      // Historical default executor is the codex HTTP runtime path.
      return codexExecutor.dispatch(input);
    case 'claude':
      return claudeExecutor.dispatch(input);
    case 'gemini-cli':
      return geminiCliExecutor.dispatch(input);
    case 'antigravity':
      return antigravityExecutor.dispatch(input);
    default:
      throw new Error(`Unsupported runtime executor: ${String(executor)}`);
  }
}
