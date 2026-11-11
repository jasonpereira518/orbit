import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PublicCard } from "@/components/card/public-card";
import { loadPublicCard } from "@/lib/cards/card-store";

/**
 * A user's public Orbit Card: what a stranger lands on after scanning their QR code. No
 * account, no Clerk (it sits in the Clerk-free `(site)` group), phone-first. Listed in
 * `PUBLIC_ROUTES`; the unguessable slug is the only key, and a paused, reset or
 * unreleased card is the same 404 as a slug that never existed.
 */
export const dynamic = "force-dynamic";

// Metadata and page read the same card once per request.
const getCard = cache(loadPublicCard);

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const card = await getCard((await params).slug);
  return {
    // Absolute: the root template would add a second "· Orbit".
    title: card ? { absolute: `${card.fullName} · Orbit` } : "Card not found",
    // A person's card is for the people they hand it to, not for search engines.
    robots: { index: false, follow: false },
  };
}

export default async function CardPage({ params }: { params: Params }) {
  const card = await getCard((await params).slug);
  if (!card) notFound();

  return (
    <main
      id="main-content"
      className="landing-root min-h-dvh bg-[#03050c] text-[#e8f3f1]"
      style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto w-full max-w-md px-5 py-10">
        <PublicCard card={card} />
        <p className="mt-10 text-center text-xs text-[#6d807c]">Shared with Orbit</p>
      </div>
    </main>
  );
}
