import { loadPublicCard } from "@/lib/cards/card-store";
import { buildVCard, vcardFileName } from "@/lib/vcard";

/**
 * "Save contact" on a public card. A plain `Response`, no `next/server`: the share-card
 * smoke imports this handler under tsx. A paused, reset or unreleased card is a 404, the
 * same as a slug that never existed.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const card = await loadPublicCard(slug);
  if (!card) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

  const vcard = buildVCard({
    fullName: card.fullName,
    org: card.company,
    title: card.title,
    email: card.email,
    phone: card.phone,
    urls: [card.linkedinUrl, card.websiteUrl].filter((u): u is string => !!u),
    note: "Met via Orbit",
  });
  const name = vcardFileName(card.fullName);
  // RFC 6266: an ASCII fallback for old clients, the real name for everyone else.
  const ascii = name.replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim() || "contact.vcf";
  return new Response(vcard, {
    headers: {
      "Content-Type": "text/vcard; charset=utf-8",
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
