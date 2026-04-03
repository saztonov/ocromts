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

  // Estimate prompt size for logging
  const promptSize = estimatePromptSize(messages);
  const jsonMode = responseFormat?.type === 'json_object';

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`[llm] Retry ${attempt}/${MAX_RETRIES} after ${delayMs}ms`);
      await sleep(delayMs);
    }

    // --- Log: sending request ---
    console.log(
      `[llm] → Sending request | Model: ${model} | Messages: ${messages.length} | ` +
      `Prompt size: ~${promptSize} chars | JSON mode: ${jsonMode} | Attempt: ${attempt + 1}/${MAX_RETRIES + 1}`
    );
    const startTime = Date.now();

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

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (response.status === 429) {
        lastError = new Error(`OpenRouter rate limited (429). Attempt ${attempt + 1}.`);
        console.warn(`[llm] ← ${lastError.message} (${elapsed}s)`);
        continue;
      }

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`[llm] ← Error ${response.status} (${elapsed}s): ${errorBody.slice(0, 300)}`);
        throw new Error(
          `OpenRouter API error ${response.status}: ${errorBody}`
        );
      }

      const data = (await response.json()) as OpenRouterResponse;

      // --- Log: response received ---
      const content = data.choices?.[0]?.message?.content;
      const contentLen = content?.length ?? 0;
      console.log(
        `[llm] ← Response received (${elapsed}s) | ` +
        `Model: ${model} | Response size: ${contentLen} chars` +
        (data.usage
          ? ` | Tokens: prompt=${data.usage.prompt_tokens}, completion=${data.usage.completion_tokens}, total=${data.usage.total_tokens}`
          : '')
      );

      if (!content) {
        throw new Error('OpenRouter returned empty content');
      }

      // --- Log: validate JSON if json mode was requested ---
      if (jsonMode) {
        const isValid = isValidJson(content);
        if (isValid) {
          console.log(`[llm] ✓ Response is valid JSON`);
        } else {
          console.warn(`[llm] ✗ Response is NOT valid JSON! First 300 chars: ${content.slice(0, 300)}`);
        }
      }

      // --- Log: preview response ---
      console.log(`[llm] Response preview: ${content.slice(0, 200)}${contentLen > 200 ? '...' : ''}`);

      return content;
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      // If the caller's signal was aborted, stop immediately (user cancel)
      if (signal?.aborted) {
        console.error(`[llm] ← Aborted by caller signal (${elapsed}s)`);
        throw err;
      }
      if (err instanceof Error && err.name === 'TimeoutError') {
        console.error(`[llm] ← Timeout after ${elapsed}s (limit: ${LLM_CALL_TIMEOUT_MS / 1000}s)`);
        throw err;
      }
      if (err instanceof Error && err.message.includes('429')) {
        lastError = err;
        continue;
      }
      console.error(`[llm] ← Error (${elapsed}s): ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  throw lastError ?? new Error('OpenRouter call failed after retries');
}

/** Estimate the total character size of messages for logging */
function estimatePromptSize(messages: ChatMessage[]): number {
  let size = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      size += msg.content.length;
    } else {
      for (const part of msg.content) {
        if (part.type === 'text') {
          size += part.text.length;
        } else if (part.type === 'file') {
          size += part.file.content.length;
        } else if (part.type === 'image_url') {
          size += part.image_url.url.length;
        }
      }
    }
  }
  return size;
}

/** Quick check if a string is valid JSON */
function isValidJson(text: string): boolean {
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1]!.trim();
  }
  try {
    JSON.parse(cleaned);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
