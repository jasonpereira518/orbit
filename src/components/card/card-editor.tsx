"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { previewMyCard, saveMyCard } from "@/actions/cards";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CardFields } from "@/db/schema";
import type { CardDraft, PublicCard } from "@/lib/cards/card-store";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

const FIELD_LABELS: Record<keyof CardFields, string> = {
  photo: "Photo",
  role: "Role and company",
  headline: "Headline",
  linkedin: "LinkedIn",
  email: "Email",
  phone: "Phone",
  website: "Website",
  location: "Location",
};

const PREVIEW_DELAY_MS = 300;

/** What's on the card: a toggle per field, phone and tagline, and a live preview of the result. */
export function CardEditor({
  initial,
  initialPreview,
  initialPreviewError,
  mode,
}: {
  initial: CardDraft;
  initialPreview: PublicCard | null;
  initialPreviewError: string | null;
  mode: "create" | "edit";
}) {
  const router = useRouter();
  const [fields, setFields] = useState(initial.fields);
  const [phone, setPhone] = useState(initial.phone ?? "");
  const [tagline, setTagline] = useState(initial.tagline ?? "");
  const [preview, setPreview] = useState(initialPreview);
  const [previewError, setPreviewError] = useState(initialPreviewError);
  const [saving, startSave] = useTransition();
  const draft = (): CardDraft => ({ fields, phone: phone.trim() || null, tagline: tagline.trim() || null });

  // The first render already has the server's preview; re-ask only once something changes.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    let live = true;
    const timer = setTimeout(async () => {
      const res = await previewMyCard({ fields, phone: phone.trim() || null, tagline: tagline.trim() || null }).catch(() => null);
      if (!live || !res) return;
      if (res.ok) {
        setPreview(res.card);
        setPreviewError(null);
      } else setPreviewError(res.message);
    }, PREVIEW_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [fields, phone, tagline]);

  const save = () =>
    startSave(async () => {
      try {
        const res = await saveMyCard(draft());
        if (!res.ok) {
          toast.error(res.message);
          return;
        }
        toast.success(mode === "create" ? "Your card is ready" : "Card saved");
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
    });

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm font-medium text-ink">Show on your card</legend>
          {(Object.keys(FIELD_LABELS) as (keyof CardFields)[]).map((key) => (
            <label key={key} className="flex min-h-8 items-center gap-2.5 text-sm">
              <Checkbox checked={fields[key]} onCheckedChange={(on) => setFields((f) => ({ ...f, [key]: on === true }))} />
              {FIELD_LABELS[key]}
            </label>
          ))}
        </fieldset>
        {fields.phone && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="card-phone">Phone number</Label>
            <Input id="card-phone" type="tel" autoComplete="tel" maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="card-tagline">Tagline</Label>
          <Input
            id="card-tagline"
            maxLength={120}
            placeholder="Building tools for founders"
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={saving} className="self-start">
          {mode === "create" ? "Create my card" : "Save changes"}
        </Button>
      </form>

      <section aria-label="Preview" aria-live="polite" className="rounded-2xl border border-border/70 bg-muted/30 p-5">
        <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">What people see</p>
        {previewError ? (
          <p className="text-sm text-muted-foreground">{previewError}</p>
        ) : preview ? (
          <CardPreview card={preview} />
        ) : null}
      </section>
    </div>
  );
}

function CardPreview({ card }: { card: PublicCard }) {
  const role = [card.title, card.company].filter(Boolean).join(" @ ");
  const lines = [card.email, card.phone, card.linkedinUrl && "LinkedIn", card.websiteUrl && "Website"].filter(Boolean);
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      {card.photoUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- the owner's photo on any host, as on the public card.
        <img src={card.photoUrl} alt="" width={64} height={64} className="mb-2 size-16 rounded-full object-cover" />
      )}
      <p className="font-[family-name:var(--font-display)] text-xl text-ink">{card.fullName}</p>
      {role && <p className="text-sm text-ink/85">{role}</p>}
      {card.headline && <p className="text-sm text-muted-foreground">{card.headline}</p>}
      {card.location && <p className="text-sm text-muted-foreground">{card.location}</p>}
      {card.tagline && <p className="mt-1 text-sm italic text-primary">{card.tagline}</p>}
      {lines.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{lines.join(" · ")}</p>}
    </div>
  );
}
