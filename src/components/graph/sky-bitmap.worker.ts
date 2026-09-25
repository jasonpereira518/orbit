/// <reference lib="webworker" />
/**
 * Draws the sky's bitmaps off the main thread and encodes them as PNG — see `useSkyBitmap` in
 * graph-nodes.tsx. Copying a GPU canvas's pixels out for an image is a synchronous read-back
 * on the thread that owns it (~70ms for the washes at 2,500 contacts, inside a search
 * keystroke); here it blocks nothing the reader can see.
 */
import { drawSkyBitmap, skyBitmapSize, type SkyBitmapJob } from "@/lib/graph/sky-bitmap-draw";

export type SkyBitmapRequest = { id: number; job: SkyBitmapJob };
export type SkyBitmapResponse = { id: number; blob: Blob } | { id: number; error: string };

self.onmessage = async (event: MessageEvent<SkyBitmapRequest>) => {
  const { id, job } = event.data;
  try {
    const { width, height } = skyBitmapSize(job);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    drawSkyBitmap(ctx, job);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    self.postMessage({ id, blob } satisfies SkyBitmapResponse);
  } catch (err) {
    self.postMessage({ id, error: String(err) } satisfies SkyBitmapResponse);
  }
};
