"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { recognitionLang } from "@/lib/assistant/lang";
import type { ReplyLanguage } from "@/lib/assistant/types";

/**
 * Continuous voice input on the Web Speech API.
 *
 * Three behaviours matter for a conversation, and all three are handled here:
 *
 *   - **Continuous.** `continuous: true`, interim results, and an auto-restart
 *     when Chrome ends a session on silence - so the person can speak again
 *     without touching the microphone.
 *   - **Echo prevention.** The assistant's own text can reach the microphone.
 *     Before a transcript is accepted it is compared with the last spoken reply;
 *     a close match is the speaker's voice and is dropped.
 *   - **Barge-in.** If the transcript is clearly *not* the reply being spoken,
 *     the person has started talking over the assistant: TTS is cancelled and
 *     their words are accepted.
 */

type SpeechAlternativeLike = { readonly transcript: string };
type SpeechResultLike = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechAlternativeLike | undefined;
};
type SpeechResultListLike = {
  readonly length: number;
  readonly [index: number]: SpeechResultLike | undefined;
};
type SpeechResultEventLike = {
  readonly resultIndex: number;
  readonly results: SpeechResultListLike;
};
type SpeechErrorEventLike = { readonly error: string };

type RecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onresult: ((event: SpeechResultEventLike) => void) | null;
  onerror: ((event: SpeechErrorEventLike) => void) | null;
  onend: (() => void) | null;
};

type RecognitionCtor = new () => RecognitionLike;
type SpeechWindow = Window & {
  SpeechRecognition?: RecognitionCtor;
  webkitSpeechRecognition?: RecognitionCtor;
};

export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Is `heard` the assistant's own `spoken` text coming back through the mic?
 * Short fragments are never treated as an echo: "okay" is a real answer even
 * when the reply contained it.
 */
export function looksLikeEcho(heard: string, spoken: string): boolean {
  const heardText = normalizeSpeech(heard);
  const spokenText = normalizeSpeech(spoken);
  if (!heardText || !spokenText) return false;

  if (heardText.length >= 8 && spokenText.includes(heardText)) return true;

  const heardWords = heardText.split(" ").filter(Boolean);
  if (heardWords.length < 3) return false;
  const spokenWords = new Set(spokenText.split(" ").filter(Boolean));
  const shared = heardWords.filter((word) => spokenWords.has(word)).length;
  return shared / heardWords.length >= 0.7;
}

export type UseVoiceOptions = {
  readonly language: ReplyLanguage;
  /** Text of the reply currently (or most recently) spoken. */
  readonly echoTextRef: RefObject<string>;
  /** True while TTS is producing sound. */
  readonly speakingRef: RefObject<boolean>;
  readonly onFinal: (text: string) => void;
  readonly onInterim?: (text: string) => void;
  readonly onBargeIn?: () => void;
  readonly onError?: (message: string) => void;
};

export function useVoice(options: UseVoiceOptions) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const recognitionRef = useRef<RecognitionLike | null>(null);
  const ctorRef = useRef<RecognitionCtor | null>(null);
  const runningRef = useRef(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const speechWindow = window as SpeechWindow;
    const ctor = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
    ctorRef.current = ctor;
    setSupported(Boolean(ctor));
  }, []);

  useEffect(() => {
    if (!supported) return;
    const ctor = ctorRef.current;
    if (!ctor) return;

    const recognition = new ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = recognitionLang(optionsRef.current.language);
    recognitionRef.current = recognition;

    const clearRestart = () => {
      if (restartTimerRef.current) {
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
    };

    const accept = (text: string) => {
      const { echoTextRef, speakingRef, onFinal, onBargeIn } = optionsRef.current;
      if (!text || looksLikeEcho(text, echoTextRef.current)) return;
      if (speakingRef.current) onBargeIn?.();
      onFinal(text);
    };

    recognition.onresult = (event) => {
      const { echoTextRef, speakingRef, onInterim, onBargeIn } = optionsRef.current;
      let interim = "";

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result) continue;
        const text = result[0]?.transcript?.trim() ?? "";
        if (!text) continue;

        if (result.isFinal) {
          accept(text);
        } else {
          interim = `${interim} ${text}`.trim();
        }
      }

      if (!interim || looksLikeEcho(interim, echoTextRef.current)) return;
      if (speakingRef.current) onBargeIn?.();
      onInterim?.(interim);
    };

    recognition.onerror = (event) => {
      const code = event.error;
      if (code === "no-speech" || code === "aborted") return;

      runningRef.current = false;
      setListening(false);
      const message =
        code === "not-allowed" || code === "service-not-allowed"
          ? "Microphone access is blocked. Allow it for this site, then try again."
          : code === "audio-capture"
            ? "No microphone was found on this device."
            : code === "network"
              ? "Voice input needs a network connection in this browser."
              : "Voice input stopped unexpectedly. Tap the microphone to try again.";
      optionsRef.current.onError?.(message);
    };

    recognition.onend = () => {
      if (!runningRef.current) {
        setListening(false);
        return;
      }
      // Chrome ends a "continuous" session on silence. Keep the microphone on
      // for the next turn, but leave a beat so start() is never called mid-end.
      clearRestart();
      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null;
        if (!runningRef.current) return;
        try {
          recognition.start();
        } catch {
          // Already started by the browser; onstart will update the state.
        }
      }, 300);
    };

    recognition.onstart = () => setListening(true);

    return () => {
      runningRef.current = false;
      clearRestart();
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onstart = null;
      try {
        recognition.abort();
      } catch {
        // Nothing to stop.
      }
      recognitionRef.current = null;
    };
  }, [supported]);

  // Changing the reply language updates recognition in place. Aborting lets the
  // onend restart reopen the session with the new locale.
  useEffect(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    recognition.lang = recognitionLang(options.language);
    if (runningRef.current) {
      try {
        recognition.abort();
      } catch {
        // Not running; nothing to restart.
      }
    }
  }, [options.language]);

  const start = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    runningRef.current = true;
    try {
      recognition.start();
    } catch {
      // Already listening - the existing session stays in charge.
    }
    setListening(true);
  }, []);

  const stop = useCallback(() => {
    runningRef.current = false;
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    const recognition = recognitionRef.current;
    if (recognition) {
      try {
        recognition.abort();
      } catch {
        // Already stopped.
      }
    }
    setListening(false);
  }, []);

  const toggle = useCallback(() => {
    if (runningRef.current) stop();
    else start();
  }, [start, stop]);

  return { supported, listening, start, stop, toggle };
}
