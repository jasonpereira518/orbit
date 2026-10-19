import { findLinkOrAddress } from "@/lib/outreach-quality";

/**
 * A warning under an AI draft that carries a link or an email address. The model writes over
 * other people's words — an inbound email, a calendar invite, an enrichment — and a planted
 * link is the payload an injection is after: the person's own mailbox sending a stranger's
 * URL. Never blocking; it names the link so the person can check it.
 *
 * `aiText` is what the model wrote, when the person may have typed links of their own since;
 * the warning then lasts while the draft still contains the model's link. Without it, the
 * whole `text` is the model's.
 */
export function DraftLinkWarning({ text, aiText }: { text: string; aiText?: string | null }) {
  const link = findLinkOrAddress(aiText ?? text);
  if (!link || !text.includes(link)) return null;
  return (
    <p className="text-xs text-warning" role="status">
      This draft includes a link or address ({link.slice(0, 60)}). Check it’s one you meant to send.
    </p>
  );
}
