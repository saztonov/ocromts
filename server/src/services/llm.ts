import { config } from '../config.js';
import { dumpRequest, dumpResponse, dumpError, stripBase64ImagesExternal, type DumpContext, type DumpAggregator } from '../utils/llm-dump.js';

/** A single message in the OpenRouter chat format. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | MessageContentPart[];
}

export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

export interface CallOpenRouterParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' };
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Если задан — все request/response/error будут сдамплены в debug/<comparisonId>/<stage>/<name>_*. */
  dumpContext?: DumpContext;
  /** Если задан — request/response/error пишутся в агрегатор (один all.json на стадию). */
  dumpAggregator?: DumpAggregator;
  /** Позиция для агрегатора (обязательна вместе с dumpAggregator). */
  dumpPosition?: number;
}

interface OpenRouterChoice {
  message: { content: string };
  finish_reason?: string;
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
const LLM_CALL_TIMEOUT_MS = config.LLM_CALL_TIMEOUT_MS;

/**
 * Calls the OpenRouter chat completions API.
 * Retries up to MAX_RETRIES times on HTTP 429 with exponential backoff.
 */
export async function callOpenRouter(params: CallOpenRouterParams): Promise<string> {
  const { model, messages, temperature = 0.1, maxTokens, responseFormat, signal, timeoutMs, dumpContext, dumpAggregator, dumpPosition } = params;
  const callTimeoutMs = timeoutMs ?? LLM_CALL_TIMEOUT_MS;

  // Дамп запроса (один раз на cовокупность попыток).
  if (dumpContext) {
    dumpRequest(dumpContext, {
      comparisonId: dumpContext.comparisonId,
      stage: dumpContext.stage,
      name: dumpContext.name,
      model,
      temperature,
      maxTokens,
      responseFormat,
      timeoutMs: callTimeoutMs,
      messages,
    });
  } else if (dumpAggregator && typeof dumpPosition === 'number') {
    const cleanedMessages = stripBase64ImagesExternal(messages, dumpAggregator.baseDir, dumpAggregator.imagesSubdir);
    dumpAggregator.record(dumpPosition, 'request', {
      model,
      temperature,
      maxTokens,
      responseFormat,
      timeoutMs: callTimeoutMs,
      messages: cleanedMessages,
    });
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
  };

  if (maxTokens) {
    body.max_tokens = maxTokens;
  }

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
      const timeoutSignal = AbortSignal.timeout(callTimeoutMs);
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
      const choice = data.choices?.[0];
      const content = choice?.message?.content;
      const finishReason = choice?.finish_reason ?? 'unknown';
      const contentLen = content?.length ?? 0;
      console.log(
        `[llm] ← Response received (${elapsed}s) | ` +
        `Model: ${model} | Response size: ${contentLen} chars | finish_reason: ${finishReason}` +
        (data.usage
          ? ` | Tokens: prompt=${data.usage.prompt_tokens}, completion=${data.usage.completion_tokens}, total=${data.usage.total_tokens}`
          : '')
      );

      if (finishReason === 'length') {
        console.warn(`[llm] ⚠ Response TRUNCATED (finish_reason=length) — output hit max_tokens limit`);
      }

      if (!content) {
        console.error(`[llm] Empty content. Raw response: ${JSON.stringify(data).slice(0, 500)}`);
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

      if (dumpContext) {
        dumpResponse(dumpContext, {
          elapsedMs: Date.now() - startTime,
          httpStatus: response.status,
          raw: data,
          content,
          finishReason,
          usage: data.usage,
          validJson: jsonMode ? isValidJson(content) : undefined,
        });
      } else if (dumpAggregator && typeof dumpPosition === 'number') {
        dumpAggregator.record(dumpPosition, 'response', {
          elapsedMs: Date.now() - startTime,
          httpStatus: response.status,
          content,
          finishReason,
          usage: data.usage,
          validJson: jsonMode ? isValidJson(content) : undefined,
        });
      }

      return content;
    } catch (err) {
      const elapsedMs = Date.now() - startTime;
      const elapsed = (elapsedMs / 1000).toFixed(1);
      // If the caller's signal was aborted, stop immediately (user cancel)
      const recordErr = (willRetry: boolean) => {
        if (dumpContext) dumpError(dumpContext, err, { attempt: attempt + 1, willRetry, elapsedMs });
        else if (dumpAggregator && typeof dumpPosition === 'number') {
          const e = err instanceof Error ? err : new Error(String(err));
          dumpAggregator.record(dumpPosition, 'error', {
            timestamp: new Date().toISOString(),
            errorName: e.name,
            errorMessage: e.message,
            attempt: attempt + 1,
            willRetry,
            elapsedMs,
          });
        }
      };
      if (signal?.aborted) {
        console.error(`[llm] ← Aborted by caller signal (${elapsed}s)`);
        recordErr(false);
        throw err;
      }
      if (err instanceof Error && err.name === 'TimeoutError') {
        console.error(`[llm] ← Timeout after ${elapsed}s (limit: ${callTimeoutMs / 1000}s)`);
        lastError = err;
        const willRetry = attempt < 2;
        recordErr(willRetry);
        if (willRetry) continue;
        throw err;
      }
      if (err instanceof Error && err.message.includes('429')) {
        lastError = err;
        recordErr(true);
        continue;
      }
      console.error(`[llm] ← Error (${elapsed}s): ${err instanceof Error ? err.message : String(err)}`);
      recordErr(false);
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
          size += part.file.file_data.length;
        } else if (part.type === 'image_url') {
          size += part.image_url.url.length;
        }
      }
    }
  }
  return size;
}

/** Quick check if a string is valid JSON (after stripping markdown fences) */
function isValidJson(text: string): boolean {
  let cleaned = text.trim();

  // Strip closed fence
  const closedFence = cleaned.match(/^```(?:json)?\s*\n([\s\S]*)\n\s*```\s*$/);
  if (closedFence) {
    cleaned = closedFence[1]!.trim();
  } else {
    // Strip unclosed fence (truncated response)
    const openFence = cleaned.match(/^```(?:json)?\s*\n([\s\S]*)$/);
    if (openFence) {
      cleaned = openFence[1]!.trim();
    }
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
