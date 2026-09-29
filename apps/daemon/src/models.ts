import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { extractReasoningMiddleware, wrapLanguageModel } from 'ai';
import type { LocalLanguageModel } from '@nova/core';
import type { Config } from './config.ts';

/**
 * Model ids are "<provider>/<model>". Local providers (LM Studio, Ollama, oMLX, mlx_lm,
 * llama.cpp, or any added in Settings) all speak the OpenAI-compatible API, so one client
 * covers them and nothing leaves the machine. Any other id resolves to nothing: there is no
 * cloud gateway, so an id is never handed to a provider behind Nova's back.
 */
export function modelResolver(servers: Config['localProviders']) {
  /** "ollama/gemma3:4b" -> the configured "ollama" server and model "gemma3:4b"; null for any other id. */
  const localTarget = (id: string) => {
    const slash = id.indexOf('/');
    const name = id.slice(0, Math.max(slash, 0)).toLowerCase();
    const server = servers[name];
    return server ? { name, model: id.slice(slash + 1), ...server } : null;
  };

  return {
    isLocal: (id: string) => localTarget(id) !== null,
    resolve(id: string): LocalLanguageModel | null {
      const local = localTarget(id);
      if (!local) return null;
      const provider = createOpenAICompatible({
        name: local.name,
        baseURL: local.url,
        apiKey: local.apiKey,
        // Sends the JSON schema so decisions come back in shape (LM Studio, Ollama, llama.cpp support it).
        supportsStructuredOutputs: local.structuredOutputs,
      });
      // Local reasoning models often inline <think>...</think>; keep it out of spoken replies.
      return wrapLanguageModel({ model: provider(local.model), middleware: extractReasoningMiddleware({ tagName: 'think' }) });
    },
  };
}
