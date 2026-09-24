"use client";

import { createContext, useContext } from "react";

const EMPTY: ReadonlySet<string> = new Set();

const HiddenSurfacesContext = createContext<ReadonlySet<string>>(EMPTY);

/**
 * The surfaces an operator has hidden from this viewer, for components deep in a page that
 * offer a way into another one — the chat composer's slash commands, today. The shell already
 * has the set for the nav and the palette; this only saves threading it through every page.
 */
export const HiddenSurfacesProvider = HiddenSurfacesContext.Provider;

export function useHiddenSurfaces(): ReadonlySet<string> {
  return useContext(HiddenSurfacesContext);
}
