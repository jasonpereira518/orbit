"use client";

/**
 * Rung 3 of the theming ladder: the cover art's dominant colour, sampled in the browser.
 *
 * Done here rather than on the server for a concrete reason — there is no image-decoding
 * library in `dependencies`. (`sharp` appears in `serverExternalPackages` but is not a
 * dependency, so it cannot be relied on.) Adding one to compute a single average colour is
 * not a trade worth making when every viewer already has a decoder.
 *
 * Renders nothing. It runs at most once per event: only when there is a cover, no better
 * signal already won, and the user has not chosen their own colour.
 *
 * Cross-origin note: a remote cover taints the canvas and `getImageData` throws. That is
 * caught and ignored — the event keeps its hash colour, which is a perfectly good outcome.
 * Once a cover is persisted to Blob it is same-origin-ish with `crossOrigin="anonymous"`
 * and the sample succeeds.
 */
import { useEffect, useRef } from "react";
import { setEventThemeColor } from "@/actions/events";
import type { EventRecord } from "@/db/schema";

export function CoverPaletteProbe({
  eventId,
  coverUrl,
  themeSource,
  themeLocked,
}: {
  eventId: string;
  coverUrl: string | null;
  themeSource: EventRecord["themeSource"];
  themeLocked: boolean;
}) {
  const done = useRef(false);

  // `meta` and `jsonld` outrank the image, and a locked theme is the user's own choice.
  const shouldSample =
    Boolean(coverUrl) && !themeLocked && (themeSource === "hash" || themeSource === null);

  useEffect(() => {
    if (!shouldSample || !coverUrl || done.current) return;
    done.current = true;

    const image = new Image();
    image.crossOrigin = "anonymous";
    image.referrerPolicy = "no-referrer";
    let cancelled = false;

    image.onload = () => {
      if (cancelled) return;
      try {
        // 32x32 is plenty for a dominant colour and keeps the whole sample under a
        // millisecond, so this never competes with the page's own paint.
        const size = 32;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return;
        context.drawImage(image, 0, 0, size, size);
        const { data } = context.getImageData(0, 0, size, size);

        // Bucket by coarse hue-ish RGB and take the modal bucket, discarding near-white,
        // near-black and washed-out pixels — a photo's background would otherwise win every
        // time and every event would come out beige.
        const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i]!;
          const g = data[i + 1]!;
          const b = data[i + 2]!;
          if (data[i + 3]! < 200) continue;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          if (max < 40 || min > 225) continue;
          if (max - min < 28) continue;
          const key = `${r >> 5}:${g >> 5}:${b >> 5}`;
          const cell = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
          cell.n += 1;
          cell.r += r;
          cell.g += g;
          cell.b += b;
          buckets.set(key, cell);
        }
        let best: { n: number; r: number; g: number; b: number } | null = null;
        for (const cell of buckets.values()) {
          if (!best || cell.n > best.n) best = cell;
        }
        if (!best || best.n < 8) return;

        const hex =
          "#" +
          [best.r, best.g, best.b]
            .map((sum) => Math.round(sum / best!.n).toString(16).padStart(2, "0"))
            .join("");
        // Fire and forget: a failed sample must never surface as an error to someone who
        // only wanted to look at their event.
        void setEventThemeColor(eventId, hex, "image").catch(() => {});
      } catch {
        // Tainted canvas. The hash colour stands.
      }
    };
    image.src = coverUrl;
    return () => {
      cancelled = true;
    };
  }, [shouldSample, coverUrl, eventId]);

  return null;
}
