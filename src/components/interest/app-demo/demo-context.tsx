"use client";

import { createContext, useContext, type Dispatch } from "react";
import type { DemoAction, DemoState } from "./demo-state";

export type DemoContextValue = {
  state: DemoState;
  dispatch: Dispatch<DemoAction>;
  /** Decided at render time from the media query — never from a one-render-late hook. */
  reduced: boolean;
};

export const DemoContext = createContext<DemoContextValue | null>(null);

export function useDemo(): DemoContextValue {
  const value = useContext(DemoContext);
  if (!value) throw new Error("useDemo outside the demo window");
  return value;
}
