import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/**
 * Turning a few seconds of Punjabi into text.
 *
 * Sarvam's Saarika is the primary engine because it is trained on Indian
 * languages and, more to the point, on the Punjabi–Hindi–English code-switching
 * a shopkeeper actually speaks: "Sharma Stationery da balance kinna hai" is
 * three languages in six words, and a monolingual model gives up somewhere in
 * the middle. Whisper is kept behind it as a fallback — weaker on Punjabi,
 * fine on the mostly-English utterances, and useful on the day Sarvam is down.
 *
 * Nothing downstream trusts this text. It is matched against the shop's own
 * records and read back on screen before it means anything, because ASR on a
 * noisy shop floor gets names wrong and always will.
 */

const SARVAM_URL = 'https://api.sarvam.ai/speech-to-text';
const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';

/** Pinned for the same reason the Claude model is: a change alters accuracy. */
const SARVAM_MODEL = 'saarika:v2.5';

/**
 * A clip that runs long is somebody who forgot to let go of the button, not a
 * question. Cutting it off keeps the bill and the latency predictable.
 */
const MAX_SECONDS = 30;

export interface AudioClip {
  data: Buffer;
  /// Whatever the browser's MediaRecorder produced — usually audio/webm.
  mediaType: string;
}

export type TranscriptResult =
  | { ok: true; transcript: string; engine: string }
  | { ok: false; reason: string; unavailable?: boolean };

export interface Transcriber {
  readonly available: boolean;
  transcribe(clip: AudioClip): Promise<TranscriptResult>;
}

const extensionFor = (mediaType: string): string => {
  const subtype = mediaType.split('/')[1]?.split(';')[0] ?? 'webm';
  // Both APIs pick their decoder off the filename, so this has to be honest.
  return subtype === 'mpeg' ? 'mp3' : subtype;
};

class SarvamTranscriber implements Transcriber {
  readonly available = true;

  constructor(private readonly apiKey: string) {}

  async transcribe(clip: AudioClip): Promise<TranscriptResult> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(clip.data)], { type: clip.mediaType }), `clip.${extensionFor(clip.mediaType)}`);
    form.append('model', SARVAM_MODEL);
    // pa-IN rather than auto-detect: the shop speaks one language, and telling
    // the engine which one is worth several points of accuracy on short clips.
    form.append('language_code', 'pa-IN');

    try {
      const response = await fetch(SARVAM_URL, {
        method: 'POST',
        headers: { 'api-subscription-key': this.apiKey },
        body: form,
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return { ok: false, reason: `Sarvam returned ${response.status}: ${detail.slice(0, 200)}` };
      }

      const payload = (await response.json()) as { transcript?: string };
      const transcript = payload.transcript?.trim();
      if (!transcript) return { ok: false, reason: 'Sarvam heard nothing in that clip' };

      return { ok: true, transcript, engine: 'sarvam' };
    } catch (error) {
      return { ok: false, reason: describe(error) };
    }
  }
}

class WhisperTranscriber implements Transcriber {
  readonly available = true;

  constructor(private readonly apiKey: string) {}

  async transcribe(clip: AudioClip): Promise<TranscriptResult> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(clip.data)], { type: clip.mediaType }), `clip.${extensionFor(clip.mediaType)}`);
    form.append('model', 'whisper-1');
    form.append('language', 'pa');

    try {
      const response = await fetch(WHISPER_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return { ok: false, reason: `Whisper returned ${response.status}: ${detail.slice(0, 200)}` };
      }

      const payload = (await response.json()) as { text?: string };
      const transcript = payload.text?.trim();
      if (!transcript) return { ok: false, reason: 'Whisper heard nothing in that clip' };

      return { ok: true, transcript, engine: 'whisper' };
    } catch (error) {
      return { ok: false, reason: describe(error) };
    }
  }
}

/**
 * The primary engine, with the other one behind it.
 *
 * Only a *failure* falls through, never a poor result — a transcript this
 * thinks is bad is still the operator's words, and second-guessing it here
 * would just make the behaviour unpredictable. Judging the wording is the
 * matching layer's job, and it shows what it heard.
 */
class FallbackTranscriber implements Transcriber {
  readonly available = true;

  constructor(
    private readonly primary: Transcriber,
    private readonly secondary: Transcriber,
  ) {}

  async transcribe(clip: AudioClip): Promise<TranscriptResult> {
    const first = await this.primary.transcribe(clip);
    if (first.ok) return first;

    logger.warn({ reason: first.reason }, 'Primary speech engine failed; falling back');
    const second = await this.secondary.transcribe(clip);
    if (second.ok) return second;

    return { ok: false, reason: `${first.reason}; then ${second.reason}` };
  }
}

class UnconfiguredTranscriber implements Transcriber {
  readonly available = false;

  async transcribe(): Promise<TranscriptResult> {
    return {
      ok: false,
      unavailable: true,
      reason: 'No speech key is configured, so questions have to be typed rather than spoken.',
    };
  }
}

function describe(error: unknown): string {
  return (error as Error)?.name === 'TimeoutError'
    ? 'The speech service did not respond in time'
    : ((error as Error)?.message ?? 'The speech service could not be reached');
}

function build(): Transcriber {
  const sarvam = env.SARVAM_API_KEY ? new SarvamTranscriber(env.SARVAM_API_KEY) : null;
  const whisper = env.OPENAI_API_KEY ? new WhisperTranscriber(env.OPENAI_API_KEY) : null;

  const [primary, secondary] =
    env.ASR_PROVIDER === 'openai' ? [whisper, sarvam] : [sarvam, whisper];

  if (primary && secondary) return new FallbackTranscriber(primary, secondary);
  return primary ?? secondary ?? new UnconfiguredTranscriber();
}

export const transcriber: Transcriber = build();

export const MAX_CLIP_SECONDS = MAX_SECONDS;

if (!transcriber.available) {
  logger.info('No SARVAM_API_KEY or OPENAI_API_KEY — voice questions can still be typed.');
}
