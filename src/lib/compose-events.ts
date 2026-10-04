/**
 * Every Compose entry point (a contact's page, ⌘K, the pending-sends card's Edit) opens the
 * one dialog `ComposeHost` mounts, by event. Client-safe: no imports.
 */
export const COMPOSE_EVENT = "orbit:compose";

export type ComposeRequest = { contactId: string | null; to?: string[]; subject?: string; body?: string };

export function openCompose(req: ComposeRequest): void {
  window.dispatchEvent(new CustomEvent<ComposeRequest>(COMPOSE_EVENT, { detail: req }));
}
