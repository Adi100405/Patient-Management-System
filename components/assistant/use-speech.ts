"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { speechLang } from "@/lib/assistant/lang";
import type { ReplyLanguage } from "@/lib/assistant/types";

/**
 * Speak assistant replies with the browser's own speech synthesis.
 *
 * No service, no key: `speechSynthesis` is local to the device. The hook picks
 * the voice whose locale matches the reply language, exposes the text it last
 * spoke (the voice hook's echo guard needs it), and keeps a synchronous
 * `speaking` ref so barge-in can cancel without waiting for React to render.
 */
export function useSpeech(language: ReplyLanguage) {
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const spokenTextRef = useRef("");
  const speakingRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    setSupported(true);

    const loadVoices = () => setVoices(window.speechSynthesis.getVoices());
    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);

    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
      // Leaving the panel must not leave a voice talking to an empty room.
      speakingRef.current = false;
      window.speechSynthesis.cancel();
    };
  }, []);

  const pickVoice = useCallback((): SpeechSynthesisVoice | null => {
    const wanted = speechLang(language).toLowerCase();
    const exact = voices.find((voice) => voice.lang.toLowerCase() === wanted);
    if (exact) return exact;
    const base = wanted.split("-")[0] ?? wanted;
    return voices.find((voice) => voice.lang.toLowerCase().startsWith(base)) ?? null;
  }, [voices, language]);

  const cancel = useCallback(() => {
    speakingRef.current = false;
    setSpeaking(false);
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const speak = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!supported || !clean) return;

      // One voice at a time: a new reply replaces the previous one.
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.lang = speechLang(language);
      const voice = pickVoice();
      if (voice) utterance.voice = voice;
      // Clinic answers are short; a natural pace reads better than a brisk one.
      utterance.rate = 1;
      utterance.pitch = 1;

      spokenTextRef.current = clean;
      speakingRef.current = true;
      setSpeaking(true);

      utterance.onend = () => {
        speakingRef.current = false;
        setSpeaking(false);
      };
      utterance.onerror = () => {
        speakingRef.current = false;
        setSpeaking(false);
      };

      window.speechSynthesis.speak(utterance);
    },
    [supported, language, pickVoice],
  );

  // A language change stops the old-language voice; the next reply uses the new one.
  useEffect(() => {
    return () => {
      speakingRef.current = false;
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, [language]);

  return { supported, speaking, speakingRef, spokenTextRef, speak, cancel };
}

/** Kept beside the hook so the picker and the hook agree on the locale. */
export type SpeechController = ReturnType<typeof useSpeech>;
