import type { snapshot } from "@/lib/outreach-v2/service";
export type Workspace = Awaited<ReturnType<typeof snapshot>>;
export type Person = Workspace["people"][number];
export type Message = Person["messages"][number];
export type Draft = Message & { person: Person };
export type Act = (work: () => Promise<unknown>, success?: string) => void;
export type DraftEdit = {
  revision: number;
  toAddress: string;
  subject: string;
  body: string;
  signature: string;
};
export type DraftEdits = Record<string, DraftEdit>;
export function draftValues(m: Message): DraftEdit {
  return {
    revision: m.revision,
    toAddress: m.toAddress ?? "",
    subject: m.subject ?? "",
    body: m.body,
    signature: m.signature,
  };
}
export function draftIsDirty(m: Message, edit?: DraftEdit) {
  if (!edit) return false;
  const original = draftValues(m);
  return (Object.keys(original) as Array<keyof DraftEdit>).some(
    (k) => edit[k] !== original[k],
  );
}
export function isReviewable(m: Message) {
  return ["idle", "failed", "cancelled"].includes(m.executionStatus);
}
/** Preserve visible ordering as research arrives; a deliberate refresh adopts new rankings. */
export function appendNewPeople(order: string[], incoming: string[]) {
  const known = new Set(order),
    live = new Set(incoming);
  return [
    ...order.filter((id) => live.has(id)),
    ...incoming.filter((id) => !known.has(id)),
  ];
}
