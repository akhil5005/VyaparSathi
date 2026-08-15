import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useRecorder } from '../lib/audio';
import type { VoiceAnswer } from '../lib/types';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Alert, ErrorAlert } from './Alert';
import { Spinner } from './Spinner';

/**
 * Asking the shop a question, out loud or typed.
 *
 * This exists for the moment a customer is standing at the counter asking what
 * they owe while both your hands are full of paper. Everything it answers could
 * be found on a screen; the point is not having to go and find it.
 *
 * It only ever reads. There is no path from here to a bill, a payment or a
 * changed record — the server refuses those outright — so it is safe to reach
 * for without thinking, which is the only way a feature like this gets used.
 */
export function AskDialog({ onClose, speech }: { onClose: () => void; speech: boolean }) {
  const recorder = useRecorder();
  const [typed, setTyped] = useState('');
  /// The question the current answer belongs to, so a "which one?" reply can be
  /// asked again with the operator's pick attached.
  const lastQuestion = useRef<string | null>(null);

  const ask = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ answer: VoiceAnswer }>('/api/ai/ask', body),
  });

  const answer = ask.data?.answer;

  async function onSpeak() {
    if (recorder.recording) {
      const clip = await recorder.stop();
      if (!clip) return;
      lastQuestion.current = null;
      ask.mutate({ audio: { data: clip.data, mediaType: clip.mediaType } });
      return;
    }
    ask.reset();
    await recorder.start();
  }

  function onType(event: React.FormEvent) {
    event.preventDefault();
    const text = typed.trim();
    if (text.length < 2) return;
    lastQuestion.current = text;
    ask.mutate({ text });
  }

  /**
   * Answering "which one did you mean?".
   *
   * The question is asked again rather than the answer being patched, because
   * the server is the only thing that knows how to answer it — and a spoken
   * question has no text to re-send, so what is repeated is the transcript the
   * server itself reported hearing.
   */
  function onPick(kind: 'party' | 'product', id: string) {
    const text = lastQuestion.current ?? answer?.understood;
    if (!text) return;
    ask.mutate({
      text,
      ...(kind === 'party' ? { pinnedPartyId: id } : { pinnedProductId: id }),
    });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Ask about the shop"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-4">
        <ErrorAlert error={ask.error} />
        {recorder.error ? <Alert tone="error">{recorder.error}</Alert> : null}

        {speech ? (
          <div className="flex flex-col items-center gap-2 py-2">
            <button
              type="button"
              onClick={() => void onSpeak()}
              disabled={ask.isPending}
              aria-label={recorder.recording ? 'Stop and ask' : 'Speak a question'}
              className={[
                'flex h-20 w-20 items-center justify-center rounded-full text-white transition',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                'disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-slate-900',
                recorder.recording
                  ? 'animate-pulse bg-rose-600 hover:bg-rose-700 focus-visible:ring-rose-500'
                  : 'bg-slate-900 hover:bg-slate-800 focus-visible:ring-slate-500 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white',
              ].join(' ')}
            >
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v4" strokeLinecap="round" />
              </svg>
            </button>
            <p className="text-sm text-slate-500">
              {recorder.recording
                ? `Listening… ${recorder.seconds}s — tap again when you have finished`
                : 'Tap and ask, in Punjabi or English'}
            </p>
          </div>
        ) : null}

        <form onSubmit={onType} className="flex gap-2">
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={speech ? 'Or type the question' : 'Type a question'}
            maxLength={500}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
          />
          <Button type="submit" loading={ask.isPending} disabled={typed.trim().length < 2}>
            Ask
          </Button>
        </form>

        {ask.isPending ? (
          <div className="flex items-center justify-center gap-3 py-6 text-sm text-slate-500">
            <Spinner className="h-5 w-5 text-slate-400" />
            Working it out…
          </div>
        ) : null}

        {answer && !ask.isPending ? <Answer answer={answer} onPick={onPick} /> : null}

        {!answer && !ask.isPending ? (
          <div className="rounded-xl border border-dashed border-slate-300 px-4 py-4 text-sm text-slate-500 dark:border-slate-700">
            <p className="mb-2 font-medium text-slate-600 dark:text-slate-400">
              Things it can answer:
            </p>
            <ul className="space-y-1">
              <li>“Sharma Stationery nu kinna paisa dena hai?”</li>
              <li>“A4 copier da kinna stock hai?”</li>
              <li>“Aj di sale kinni hoi?”</li>
              <li>“What did we last sell JK Copier at?”</li>
            </ul>
            <p className="mt-3">
              It only looks things up. Bills, payments and changes are still made on the screens.
            </p>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function Answer({
  answer,
  onPick,
}: {
  answer: VoiceAnswer;
  onPick: (kind: 'party' | 'product', id: string) => void;
}) {
  return (
    <div className="space-y-3">
      {/* What it heard comes first and stays visible: on a shop floor the
          transcript is wrong often enough that an answer without it is a
          mystery rather than a mistake. */}
      <p className="text-sm text-slate-500">
        Heard: <span className="italic">“{answer.heard}”</span>
        {answer.understood !== answer.heard ? (
          <>
            {' '}
            → <span className="tabular">{answer.understood}</span>
          </>
        ) : null}
      </p>

      <p
        // Announced, because the operator is looking at a customer and not at
        // the screen when the answer lands.
        aria-live="polite"
        className="rounded-xl bg-slate-100 px-4 py-3 text-lg font-medium text-slate-900 dark:bg-slate-800 dark:text-slate-100"
      >
        {answer.answer}
      </p>

      {answer.choices?.options.length ? (
        <div className="space-y-2">
          <p className="text-sm text-slate-500">
            {answer.choices.kind === 'party' ? 'Which account?' : 'Which item?'}
          </p>
          <div className="flex flex-wrap gap-2">
            {answer.choices.options.map((option) => (
              <Button
                key={option.id}
                variant="secondary"
                size="sm"
                onClick={() => onPick(answer.choices!.kind, option.id)}
              >
                {option.name}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {answer.details.length ? (
        <dl className="grid gap-2 sm:grid-cols-2">
          {answer.details.map((detail) => (
            <div
              key={`${detail.label}-${detail.value}`}
              className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/60"
            >
              <dt className="text-xs text-slate-500">{detail.label}</dt>
              <dd className="text-sm font-medium text-slate-900 dark:text-slate-100">
                {detail.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
