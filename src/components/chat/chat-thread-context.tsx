"use client";

import { createContext, useContext } from "react";

/**
 * The open conversation's id, for controls deep in a message that have to come back to it —
 * the Gmail connect round trip lands on `/chat?thread=<id>`. Provided by `ChatPanel`, which
 * owns the id; read by the send dialog, which would otherwise need it threaded through three
 * layers of props it does not otherwise use.
 */
const ChatThreadContext = createContext<string | null>(null);

export const ChatThreadProvider = ChatThreadContext.Provider;

export function useChatThreadId(): string | null {
  return useContext(ChatThreadContext);
}
