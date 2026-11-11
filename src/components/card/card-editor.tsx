"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Shuffle } from "lucide-react";
import { toast } from "sonner";
import { previewMyCard, saveMyCard } from "@/actions/cards";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OrbitCard } from "@/components/card/orbit-card";
import type { CardFields } from "@/db/schema";
import { ACCENTS, ACCENT_KEYS, type AccentKey } from "@/lib/cards/card-art";
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

/** What's on the card: a toggle per field, phone and tagline, its colour and stars, and a live preview. */
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
  const [artSalt, setArtSalt] = useState(initial.artSalt ?? 0);
  const [accent, setAccent] = useState<AccentKey | null>(initial.accent ?? null);
  const [preview, setPreview] = useState(initialPreview);
  const [previewError, setPreviewError] = useState(initialPreviewError);
  const [saving, startSave] = useTransition();
  const draft = (): CardDraft => ({ fields, phone: phone.trim() || null, tagline: tagline.trim() || null, artSalt, accent });

  // The first render already has the server's preview; re-ask only once something changes.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    let live = true;
    const timer = setTimeout(async () => {
      const res = await previewMyCard({ fields, phone: phone.trim() || null, tagline: tagline.trim() || null, artSalt, accent }).catch(
        () => null
      );
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
  }, [fields, phone, tagline, artSalt, accent]);

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
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm font-medium text-ink">Colour</legend>
          <div className="flex flex-wrap items-center gap-2">
            {([null, ...ACCENT_KEYS] as const).map((key) => (
              <label key={key ?? "auto"} className="relative cursor-pointer">
                <input
                  type="radio"
                  name="card-accent"
                  className="peer sr-only"
                  checked={accent === key}
                  onChange={() => setAccent(key)}
                />
                <span
                  className="flex h-8 min-w-8 items-center justify-center rounded-full border border-border px-2 text-xs text-muted-foreground transition-shadow peer-checked:ring-2 peer-checked:ring-ring peer-checked:ring-offset-2 peer-checked:ring-offset-background peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50"
                  style={key ? { background: ACCENTS[key].hex, borderColor: "transparent" } : undefined}
                >
                  {key ? <span className="sr-only">{ACCENTS[key].label}</span> : "Auto"}
                </span>
              </label>
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setArtSalt((s) => s + 1)}>
            <Shuffle aria-hidden />
            Shuffle my stars
          </Button>
        </fieldset>
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
      <OrbitCard art={card.art} name={card.fullName} role={role || null} firstName={card.firstName} entrance className="mb-3" />
      {card.photoUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- the owner's photo on any host, as on the public card.
        <img src={card.photoUrl} alt="" width={48} height={48} className="mb-1 size-12 rounded-full object-cover" />
      )}
      {card.headline && <p className="text-sm text-muted-foreground">{card.headline}</p>}
      {card.location && <p className="text-sm text-muted-foreground">{card.location}</p>}
      {card.tagline && <p className="mt-1 text-sm italic text-primary">{card.tagline}</p>}
      {lines.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{lines.join(" · ")}</p>}
    </div>
  );
}
