"use client";
import { useSyncExternalStore } from "react";
import { createExternalStore } from "@/lib/create-external-store";

/** Captions under Cosmo while it speaks: off by default, remembered per device. */
const KEY = "orbit:cosmo-captions";

let on: boolean | null = null;
const read = () => {
  if (on === null) {
    try {
      on = localStorage.getItem(KEY) === "on";
    } catch {
      on = false;
    }
  }
  return on;
};
const store = createExternalStore({ getSnapshot: read, getServerSnapshot: () => false });

export function setCaptions(next: boolean) {
  on = next;
  try {
    if (next) localStorage.setItem(KEY, "on");
    else localStorage.removeItem(KEY);
  } catch {
    /* Private mode: on for this tab only. */
  }
  store.emit();
}

export function useCaptions(): boolean {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}
