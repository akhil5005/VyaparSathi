import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Talking to Claude.
 *
 * Plain `fetch` rather than the SDK, matching `notifier.ts`: one endpoint, one
 * JSON body, and a dependency avoided. The same reasoning applies to the
 * fallback — when no key is configured this does not pretend, it says so, and
 * every caller is expected to degrade rather than break. An AI feature that is
 * unavailable should look unavailable, not broken.
 *
 * Nothing here writes to the database and nothing here is trusted. Every
 * caller treats the result as a *draft* a person confirms.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/** Pinned deliberately: a model change alters extraction behaviour and must be a decision. */
export const MODEL = 'claude-opus-5';

export interface ImagePart {
  /// Base64, no data: prefix.
  data: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface ExtractRequest {
  system: string;
  prompt: string;
  images?: ImagePart[];
  /// JSON Schema the reply must satisfy, enforced by a tool definition.
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export type ExtractResult<T> =
  | { ok: true; value: T; usage: { inputTokens: number; outputTokens: number } }
  | { ok: false; reason: string; unavailable?: boolean };

export interface Extractor {
  readonly available: boolean;
  extract<T>(request: ExtractRequest): Promise<ExtractResult<T>>;
}

class ClaudeExtractor implements Extractor {
  readonly available = true;

  constructor(private readonly apiKey: string) {}

  async extract<T>(request: ExtractRequest): Promise<ExtractResult<T>> {
    /**
     * A single tool with the caller's schema, and `tool_choice` forcing it.
     *
     * This is what makes the reply parseable. Asking for JSON in the prompt
     * gets JSON most of the time, wrapped in prose some of the time, and the
     * failure is silent — a regex that usually works. Forcing a tool call
     * makes the shape the API's problem rather than ours.
     */
    const body = {
      model: MODEL,
      max_tokens: request.maxTokens ?? 4096,
      system: request.system,
      tools: [
        {
          name: 'record',
          description: 'Record what was read. Every field must come from the input.',
          input_schema: request.schema,
        },
      ],
      tool_choice: { type: 'tool', name: 'record' },
      messages: [
        {
          role: 'user',
          content: [
            ...(request.images ?? []).map((image) => ({
              type: 'image',
              source: { type: 'base64', media_type: image.mediaType, data: image.data },
            })),
            { type: 'text', text: request.prompt },
          ],
        },
      ],
    };

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': API_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        // A scan that hangs holds an HTTP worker open while somebody stands at
        // a counter. Reading a bill takes seconds; a minute means it failed.
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return { ok: false, reason: `Claude returned ${response.status}: ${detail.slice(0, 300)}` };
      }

      const payload = (await response.json()) as {
        content?: { type: string; name?: string; input?: unknown }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      const call = payload.content?.find((part) => part.type === 'tool_use');
      if (!call?.input) {
        return { ok: false, reason: 'Claude replied without using the tool it was given' };
      }

      return {
        ok: true,
        value: call.input as T,
        usage: {
          inputTokens: payload.usage?.input_tokens ?? 0,
          outputTokens: payload.usage?.output_tokens ?? 0,
        },
      };
    } catch (error) {
      const message = (error as Error)?.name === 'TimeoutError'
        ? 'Claude did not respond in time'
        : (error as Error).message;
      return { ok: false, reason: message };
    }
  }
}

/// Used when no key is configured. Says so, rather than failing obscurely.
class UnconfiguredExtractor implements Extractor {
  readonly available = false;

  async extract<T>(): Promise<ExtractResult<T>> {
    return {
      ok: false,
      unavailable: true,
      reason: 'No ANTHROPIC_API_KEY is configured, so this feature is switched off.',
    };
  }
}

export const extractor: Extractor = env.ANTHROPIC_API_KEY
  ? new ClaudeExtractor(env.ANTHROPIC_API_KEY)
  : new UnconfiguredExtractor();

if (!extractor.available) {
  logger.info(
    'ANTHROPIC_API_KEY is not set — bill scanning and voice queries will report themselves as unavailable.',
  );
}
