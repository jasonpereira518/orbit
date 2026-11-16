"use client";
import { useEffect, useRef, useState } from "react";
import { useVoiceCall, voiceControls } from "@/lib/voice/call-store";
import { captionTail, captionWordCount, plainSpeech } from "@/lib/voice/caption-pace";

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

type Line = { text: string; count: number; cut: boolean };

/**
 * What Cosmo is saying, a few words behind its voice, beside the docked bar. Deepgram hands Orbit
 * the audio, so words follow real playback (`getPlayback`); without it they follow a typical
 * speaking rate from when speech began. A line cut off by the person keeps what was said, marked
 * with an ellipsis. Your own last line sits above it, dimmed.
 *
 * Deliberately NOT a live region: a screen reader already hears the voice, and re-announcing
 * every few words is the pile-up this app has been bitten by before.
 */
export function CosmoCaption() {
  const { lines, mode } = useVoiceCall();
  const lastAi = lines.findLast((line) => line.source === "ai")?.text ?? null;
  const lastUser = lines.findLast((line) => line.source === "user")?.text ?? null;
  const [shown, setShown] = useState<Line | null>(null);
  const live = useRef({ mode, lastAi });
  useEffect(() => {
    live.current = { mode, lastAi };
  }, [mode, lastAi]);

  useEffect(() => {
    let frame = 0;
    let since = 0;
    let current: Line | null = null;
    const tick = (now: number) => {
      const speaking = live.current.mode === "speaking";
      if (speaking && !since) since = now;
      if (!speaking) since = 0;
      let next = current;
      const getPlayback = voiceControls.current?.getPlayback;
      if (getPlayback) {
        const playback = getPlayback();
        if (playback?.text) {
          const n = captionWordCount(playback.text, playback);
          const same = current?.text === playback.text;
          if (!same || n > current!.count) next = { text: playback.text, count: Math.max(n, same ? current!.count : 0), cut: false };
        } else if (!playback && current && !current.cut && current.count < wordCount(current.text)) {
          // The line stopped before it finished: the person cut in.
          next = { ...current, cut: true };
        }
      } else if (live.current.lastAi) {
        const text = live.current.lastAi;
        const n = speaking
          ? captionWordCount(text, { played: (now - since) / 1000, queued: 0, complete: false })
          : wordCount(text);
        if (current?.text !== text || n !== current.count) next = { text, count: n, cut: false };
      }
      if (next !== current) {
        current = next;
        setShown(next);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const said = shown ? captionTail(plainSpeech(shown.text), shown.count) : "";
  if (!said && !lastUser) return null;
  return (
    <div data-cosmo-caption className="pointer-events-auto w-full rounded-2xl border border-border/70 bg-card px-3 py-2 text-sm shadow-lg">
      {lastUser && <p className="truncate text-xs text-muted-foreground">You: {plainSpeech(lastUser)}</p>}
      {said && (
        <p className="line-clamp-2 text-foreground" data-cut={shown?.cut || undefined}>
          {said}
          {shown?.cut && "…"}
        </p>
      )}
    </div>
  );
}
