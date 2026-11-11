import Link from "next/link";
import { redirect } from "next/navigation";
import { X } from "lucide-react";
import { getMyCardQr, previewMyCard } from "@/actions/cards";
import { ArrivalsList } from "@/components/card/arrivals-list";
import { CardQr } from "@/components/card/card-qr";
import { KeepScreenAwake } from "@/components/card/card-share-panel";
import { OrbitCard } from "@/components/card/orbit-card";
import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { RenderStamp } from "@/components/layout/render-stamp";
import { buttonVariants } from "@/components/ui/button";
import { requireUserId } from "@/lib/auth";
import { listArrivals } from "@/lib/cards/arrivals";
import { getCardForOwner } from "@/lib/cards/card-store";
import { cn } from "@/lib/utils";

export const metadata = { title: "Show your card" };

/**
 * The card, full screen, for the person in front of you: QR side up, upright so the code is as
 * large as the screen allows, tap to flip to the name side. Covers the app chrome on purpose,
 * and always dark — the card's own night sky, whatever the app theme.
 */
export default async function ShowCardPage() {
  const gate = await pageVisibilityGate("page.card");
  if (gate) {
    return (
      <>
        <RenderStamp />
        {gate}
      </>
    );
  }

  const userId = await requireUserId();
  const card = await getCardForOwner(userId);
  if (!card) redirect("/card");
  const [qr, preview, arrivals] = await Promise.all([getMyCardQr(), previewMyCard(card), listArrivals(userId, 3)]);

  return (
    <div className="dark oc-dust fixed inset-0 z-50 flex flex-col items-center overflow-y-auto px-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] text-foreground">
      <RenderStamp />
      <KeepScreenAwake />
      <Link
        href="/card"
        aria-label="Close full screen"
        className={cn(buttonVariants({ variant: "outline", size: "icon-lg" }), "self-end rounded-full")}
      >
        <X aria-hidden />
      </Link>
      <div className="flex w-full flex-1 flex-col items-center justify-center gap-4 py-4 text-center">
        {qr.ok && preview.ok ? (
          <>
            <h1 className="sr-only">{preview.card.fullName}</h1>
            <OrbitCard
              art={preview.card.art}
              name={preview.card.fullName}
              role={[preview.card.title, preview.card.company].filter(Boolean).join(" @ ") || null}
              firstName={preview.card.firstName}
              qrSvg={qr.svg}
              side="back"
              orientation="portrait"
              // As wide as the screen, and short enough that the whole card fits on it.
              className="w-[min(100%,calc((100dvh_-_9rem)/1.586))]"
            />
            <p className="text-sm text-muted-foreground">Tap the card to flip it</p>
          </>
        ) : qr.ok ? (
          <>
            <CardQr svg={qr.svg} className="w-[min(80vw,80dvh)] max-w-none" />
            <p className="text-muted-foreground">Scan to save my contact</p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{qr.message}</p>
        )}
        {card.pausedAt && <p className="text-sm text-warning">Your card is paused — the code shows nothing until you turn it back on.</p>}
      </div>
      <section aria-labelledby="show-arrivals" className="w-full max-w-md">
        <h2 id="show-arrivals" className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
          Latest arrivals
        </h2>
        <ArrivalsList initial={arrivals} limit={3} />
      </section>
    </div>
  );
}
