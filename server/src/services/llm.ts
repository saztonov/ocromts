import { config } from '../config.js';

/** A single message in the OpenRouter chat format. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | MessageContentPart[];
}

export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; content: string } };

export interface CallOpenRouterParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  responseFormat?: { type: 'json_object' };
  signal?: AbortSignal;
}

interface OpenRouterChoice {
  message: { content: string };
}

interface OpenRouterResponse {
  choices: OpenRouterChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;
const LLM_CALL_TIMEOUT_MS = 300_000; // 5 minutes per LLM call

/**
 * Calls the OpenRouter chat completions API.
 * Retries up to MAX_RETRIES times on HTTP 429 with exponential backoff.
 */
export async function callOpenRouter(params: CallOpenRouterParams): Promise<string> {
  const { model, messages, temperature = 0.1, responseFormat, signal } = params;

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
  };

  if (responseFormat) {
    body.response_format = responseFormat;
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`[llm] Retry ${attempt}/${MAX_RETRIES} after ${delayMs}ms`);
      await sleep(delayMs);
    }

    try {
      // Combine caller's abort signal with per-call timeout
      const timeoutSignal = AbortSignal.timeout(LLM_CALL_TIMEOUT_MS);
      const fetchSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://ocromts.local',
          'X-Title': 'OCROMTS - Order vs Invoice Comparison',
        },
        body: JSON.stringify(body),
        signal: fetchSignal,
      });

      if (response.status === 429) {
        lastError = new Error(`OpenRouter rate limited (429). Attempt ${attempt + 1}.`);
        console.warn(`[llm] ${lastError.message}`);
        continue;
      }

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `OpenRouter API error ${response.status}: ${errorBody}`
        );
      }

      const data = (await response.json()) as OpenRouterResponse;

      if (data.usage) {
        console.log(
          `[llm] Model: ${model} | Tokens: prompt=${data.usage.prompt_tokens}, ` +
          `completion=${data.usage.completion_tokens}, total=${data.usage.total_tokens}`
        );
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('OpenRouter returned empty content');
      }

      return content;
    } catch (err) {
      // If the caller's signal was aborted, stop immediately (user cancel)
      if (signal?.aborted) {
        throw err;
      }
      if (err instanceof Error && err.message.includes('429')) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error('OpenRouter call failed after retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
