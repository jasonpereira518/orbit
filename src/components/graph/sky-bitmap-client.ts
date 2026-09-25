"use client";

import type { SkyBitmapJob } from "@/lib/graph/sky-bitmap-draw";
import type {
  SkyBitmapRequest,
  SkyBitmapResponse,
} from "@/components/graph/sky-bitmap.worker";

/**
 * The page's side of `sky-bitmap.worker.ts`: one worker for the whole sky, started on first use.
 *
 * `renderSkyBitmap` resolves with the PNG of a job, or null where this browser cannot draw off
 * the main thread (no module workers or no `OffscreenCanvas`) or the worker failed. Null means
 * "keep the canvas", which is exactly what the chart did before there was a worker.
 */
let worker: Worker | null = null;
let unavailable = false;
let nextId = 0;
const waiting = new Map<number, (blob: Blob | null) => void>();

function getWorker(): Worker | null {
  if (worker || unavailable) return worker;
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
    unavailable = true;
    return null;
  }
  try {
    worker = new Worker(new URL("./sky-bitmap.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    unavailable = true;
    return null;
  }
  worker.onmessage = (event: MessageEvent<SkyBitmapResponse>) => {
    const done = waiting.get(event.data.id);
    waiting.delete(event.data.id);
    done?.("blob" in event.data ? event.data.blob : null);
  };
  worker.onerror = () => {
    // A worker that cannot start (a blocked or failed chunk) fails every job; stop using it.
    unavailable = true;
    worker?.terminate();
    worker = null;
    for (const done of waiting.values()) done(null);
    waiting.clear();
  };
  return worker;
}

/** Whether bitmaps can be drawn off the main thread here. */
export function skyBitmapWorkerAvailable() {
  return getWorker() !== null;
}

export function renderSkyBitmap(job: SkyBitmapJob): Promise<Blob | null> {
  const w = getWorker();
  if (!w) return Promise.resolve(null);
  const id = ++nextId;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    w.postMessage({ id, job } satisfies SkyBitmapRequest);
  });
}
