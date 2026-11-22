"use client";

import { formatDistanceToNow } from "date-fns";
import { Briefcase, CalendarDays, FileText, Link2, Mail, Quote, User } from "lucide-react";
import { safeHttpUrl } from "@/lib/safe-links";
import type { RadarEvidence, RadarProof } from "@/lib/radar/types";

/** At most this many chips under a card: the lead reason's proof and one more. */
const SHOWN = 2;
const QUOTE_MAX = 80;

const chipClass =
  "inline-flex max-w-full min-w-0 items-baseline gap-1 rounded-xl border border-border/60 bg-muted/40 px-2 py-0.5 text-left text-xs text-muted-foreground";

function iconFor(proof: RadarProof | undefined, url: string | null) {
  if (url || proof?.type === "url") return Link2;
  if (proof?.type === "quote") return Quote;
  switch (proof?.table) {
    case "interactions":
    case "events":
      return CalendarDays;
    case "contact_career_moves":
      return Briefcase;
    case "email_events":
      return Mail;
    case "contacts":
      return User;
    default:
      return FileText;
  }
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Why a card can be trusted, as small chips: a quote from the person's own notes or messages,
 * a link the search returned, or an Orbit record. Built from evidence the proof check kept
 * (`src/lib/radar/verify.ts`); a link is re-checked here rather than trusted from the row.
 */
export function ProofChips({ evidence }: { evidence: readonly RadarEvidence[] }) {
  const shown = evidence.filter((e) => e.label || e.proof).slice(0, SHOWN);
  if (shown.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Proof">
      {shown.map((e, i) => {
        const url = safeHttpUrl(e.url ?? (e.proof?.type === "url" ? e.proof.url : null));
        const Icon = iconFor(e.proof, url);
        const quote = e.proof?.type === "quote" ? e.proof.quote : null;
        const text = quote
          ? `“${quote.length > QUOTE_MAX ? `${quote.slice(0, QUOTE_MAX - 1)}…` : quote}”`
          : url
            ? `${e.label} · ${hostOf(url)}`
            : e.label;
        const when = e.at ? formatDistanceToNow(new Date(e.at), { addSuffix: true }) : null;
        const body = (
          <>
            <Icon className="size-3 shrink-0 translate-y-0.5" aria-hidden />
            {/* Wraps rather than truncates: a quote cut short is not proof of anything. */}
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {text}
              {when && <span suppressHydrationWarning> · {when}</span>}
            </span>
          </>
        );
        return (
          <li key={`${e.code ?? "e"}-${i}`} className="max-w-full" title={quote ?? undefined}>
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer nofollow" className={`${chipClass} hover:text-ink hover:underline`}>
                {body}
              </a>
            ) : (
              <span className={chipClass}>{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
