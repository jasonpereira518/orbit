/** The interaction an open edit form may write to: only the one its fields were seeded from. */
export function editTarget(editingId: string | null, interactionId: string | null): string | null {
  return editingId !== null && editingId === interactionId ? editingId : null;
}
