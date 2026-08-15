import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Holding down a button and speaking.
 *
 * `MediaRecorder` is deliberately awkward: it is event-driven, the data only
 * arrives after `stop()` has fired an event, and the microphone stays lit until
 * every track is stopped by hand. Wrapping it in a promise-returning hook keeps
 * that mess out of the dialog, and — more to the point — puts the track
 * cleanup somewhere that also runs when the component unmounts. A recording
 * dialog closed mid-sentence must not leave the microphone indicator on.
 */

const MAX_SECONDS = 30;

export interface Recording {
  /// Base64 without the data: prefix, which is what the API expects.
  data: string;
  mediaType: string;
  seconds: number;
}

/**
 * Opus in a WebM container where it is supported, which is everywhere except
 * Safari; Safari records mp4/AAC and both speech engines accept it. Asking for
 * a codec the browser does not have throws, so the list is tried in order.
 */
const PREFERRED = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', ''];

const pickMimeType = (): string =>
  PREFERRED.find((type) => type === '' || MediaRecorder.isTypeSupported(type)) ?? '';

export function useRecorder() {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);

  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const supported =
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia;

  /// Cuts every track, which is what actually turns the microphone light off.
  const release = useCallback(() => {
    recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
    recorderRef.current = null;
  }, []);

  useEffect(() => release, [release]);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000)),
      250,
    );
    return () => window.clearInterval(timer);
  }, [recording]);

  const start = useCallback(async () => {
    setError(null);
    if (!supported) {
      setError('This browser cannot record audio. Type the question instead.');
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // A shop is a noisy room and the phone is on a counter, not at a mouth.
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.start();

      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      setSeconds(0);
      setRecording(true);
      return true;
    } catch {
      // Overwhelmingly a denied permission prompt, and the browser gives no
      // useful detail beyond that.
      setError('The microphone could not be used. Allow access, or type the question.');
      return false;
    }
  }, [supported]);

  const stop = useCallback(async (): Promise<Recording | null> => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      setRecording(false);
      return null;
    }

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () =>
        resolve(new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' }));
      recorder.stop();
    });

    const elapsed = Math.round((Date.now() - startedAtRef.current) / 1000);
    release();
    setRecording(false);

    // Roughly the length of a tap — a slip of the finger, not a question.
    if (blob.size < 2000) {
      setError('That was too short to make out. Hold the button while you speak.');
      return null;
    }

    return {
      data: base64Of(await blob.arrayBuffer()),
      mediaType: blob.type.split(';')[0] || 'audio/webm',
      seconds: elapsed,
    };
  }, [release]);

  /**
   * A stuck button should not record until the tab is closed. Thirty seconds
   * is far longer than any question and short enough to bound the upload.
   */
  useEffect(() => {
    if (!recording) return;
    const timer = window.setTimeout(() => void stop(), MAX_SECONDS * 1000);
    return () => window.clearTimeout(timer);
  }, [recording, stop]);

  return { supported, recording, seconds, error, start, stop, maxSeconds: MAX_SECONDS };
}

/// Chunked for the same reason as in image.ts: spreading a whole buffer across
/// `String.fromCharCode(...)` overflows the stack.
function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
