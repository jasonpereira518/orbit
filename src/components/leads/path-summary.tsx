import { ClosenessTierBadge } from "@/components/dashboard/closeness-tier-badge";
import type { IdentityKind } from "@/lib/duplicates";
import type { WarmPath } from "@/lib/leads/warm-path";

const MATCHED_ON: Record<IdentityKind, string> = {
  email: "email",
  linkedin_slug: "LinkedIn",
  phone_e164: "phone",
  x_handle: "X",
};

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/**
 * Who on the team knows a lead — the whole of what a lookup reveals: a teammate's name, how
 * close they are, how they matched, and how many others they know at the company. Never an
 * email: a teammate's address is used only inside the intro link. Hook-free, so server pages,
 * client lists and the smoke all render it.
 */
export function PathSummary({
  path,
  companyName,
  compact = false,
}: {
  path: WarmPath;
  companyName: string | null;
  compact?: boolean;
}) {
  const company = companyName ?? "their company";

  if (compact) {
    const direct = path.direct.map((d) => `${firstName(d.teammate.name)} (${d.tier})`).join(", ");
    const viaCompany = path.account.length
      ? `people at ${company} via ${path.account.map((a) => firstName(a.teammate.name)).join(", ")}`
      : "";
    const line = [direct, viaCompany].filter(Boolean).join(" · ");
    // This branch is also rendered inside a <button> (leads-pipeline.tsx's row): a button's
    // content model is phrasing content only, so this stays a span, never a p.
    return <span className="block truncate text-xs text-muted-foreground">{line || "Nobody on your team yet"}</span>;
  }

  if (!path.direct.length && !path.account.length) {
    return <p className="text-sm text-muted-foreground">Nobody on your team knows them yet.</p>;
  }

  return (
    <div className="space-y-3">
      {path.direct.length > 0 && (
        <ul className="space-y-1.5" aria-label="Teammates who know them">
          {path.direct.map((d) => (
            <li key={d.teammate.userId} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-ink">{d.teammate.name}</span>
              <ClosenessTierBadge tier={d.tier} />
              <span className="text-xs text-muted-foreground">via {MATCHED_ON[d.matchedOn]}</span>
            </li>
          ))}
        </ul>
      )}
      {path.account.length > 0 && (
        <ul className="space-y-1.5" aria-label={`Teammates who know people at ${company}`}>
          {path.account.map((a) => (
            <li key={a.teammate.userId} className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>
                <span className="font-medium text-ink">{a.teammate.name}</span> knows {a.count}{" "}
                {a.count === 1 ? "other" : "others"} at {company}
              </span>
              <ClosenessTierBadge tier={a.bestTier} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
