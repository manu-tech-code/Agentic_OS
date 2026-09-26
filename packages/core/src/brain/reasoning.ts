import { generateText, type LanguageModel } from 'ai';

export type Turn = {
  user: string;
  nova: string;
};

/** The System 2 contract: any model or agent that can think and reply. */
export interface ReasoningBrain {
  readonly name: string;
  reply(utterance: string, history: Turn[], abortSignal?: AbortSignal): Promise<string>;
}

const SYSTEM = `You are Nova, a voice-first assistant running on the user's computer.
Your reply will be spoken aloud: answer in one to three short sentences, no markdown, no lists.
If the request needs an action you cannot take, say so briefly.`;

/** Any AI SDK language model - pass a Gateway id like "anthropic/claude-sonnet-5" or "openai/gpt-5.6". */
export class LlmReasoningBrain implements ReasoningBrain {
  constructor(
    private readonly model: LanguageModel,
    readonly name: string = typeof model === 'string' ? model : 'custom',
  ) {}

  async reply(utterance: string, history: Turn[], abortSignal?: AbortSignal): Promise<string> {
    const { text } = await generateText({
      model: this.model,
      system: SYSTEM,
      abortSignal,
      messages: [
        ...history.flatMap((t) => [
          { role: 'user' as const, content: t.user },
          { role: 'assistant' as const, content: t.nova },
        ]),
        { role: 'user' as const, content: utterance },
      ],
    });
    return text.trim();
  }
}
