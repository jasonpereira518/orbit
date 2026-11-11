import { getMyCardQr, previewMyCard } from "@/actions/cards";
import { ArrivalsList } from "@/components/card/arrivals-list";
import { CardEditor } from "@/components/card/card-editor";
import { CardSharePanel } from "@/components/card/card-share-panel";
import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { RenderStamp } from "@/components/layout/render-stamp";
import { Card, CardContent } from "@/components/ui/card";
import { requireUserId } from "@/lib/auth";
import { listArrivals } from "@/lib/cards/arrivals";
import { DEFAULT_CARD_FIELDS, getCardForOwner } from "@/lib/cards/card-store";

export const metadata = { title: "Your card" };

export default async function CardPage() {
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
  const draft = card ?? { fields: DEFAULT_CARD_FIELDS, phone: null, tagline: null };
  const [preview, qr, arrivals] = await Promise.all([
    previewMyCard(draft),
    card ? getMyCardQr() : null,
    card ? listArrivals(userId) : [],
  ]);
  const editor = (
    <CardEditor
      mode={card ? "edit" : "create"}
      initial={draft}
      initialPreview={preview.ok ? preview.card : null}
      initialPreviewError={preview.ok ? null : preview.message}
    />
  );

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <RenderStamp />
      <div className="reveal-mount">
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">Your card</h1>
        <p className="mt-1 text-muted-foreground">
          Let someone scan your code to save your contact — and send you theirs back.
        </p>
      </div>

      {!card ? (
        <Card>
          <CardContent>{editor}</CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent>
              {qr?.ok ? (
                <CardSharePanel url={qr.url} svg={qr.svg} paused={card.pausedAt !== null} card={preview.ok ? preview.card : null} />
              ) : (
                <p className="text-sm text-muted-foreground">{qr?.message}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <details className="group">
                <summary className="cursor-pointer text-sm font-medium text-ink">Edit what’s on your card</summary>
                <div className="pt-5">{editor}</div>
              </details>
            </CardContent>
          </Card>

          <section aria-labelledby="arrivals-heading" className="space-y-3">
            <h2 id="arrivals-heading" className="font-[family-name:var(--font-display)] text-xl text-ink">
              Arrivals
            </h2>
            <Card>
              <CardContent>
                <ArrivalsList initial={arrivals} />
              </CardContent>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
