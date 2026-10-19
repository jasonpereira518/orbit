/**
 * The keys that decide whether two reports are the same event.
 *
 * ## Why a URL alone is not enough
 *
 * The same Luma event reaches us as `lu.ma/abc` from a two-year-old email, `luma.com/abc`
 * from a link copied today, `lu.ma/abc?tk=<token>` from the user's own invite, and
 * `lu.ma/e/evt-XYZ` from the ICS feed. Keyed on the URL as typed, that is four events on the
 * user's page, all of them the same party.
 *
 * So each candidate produces up to three keys, strongest first:
 *
 *   1. `provider` — `luma:evt-XYZ`. The platform's own id: survives a renamed slug and a
 *      moved domain, and is the only key two different sources reliably agree on.
 *   2. `url` — the canonicalised link, lowercased host, `lu.ma` folded onto `luma.com`.
 *   3. `source_ref` — `gcal:<iCalUID>`. Weakest as an identity (it names the REPORT, not the
 *      event) and yet indispensable: it is the only key available for an event whose public
 *      identity we do not know, and it is what makes re-reading the same feed idempotent.
 *
 * Pure: no network, no database.
 */
import { canonicalizeEventUrl } from "@/lib/events/canonical-url";
import { platformOf } from "@/lib/events/platforms";
import type { AliasKey, DiscoveryCandidate } from "@/lib/events/discovery/types";

/**
 * A URL reduced to the form two sources will agree on.
 *
 * `lu.ma` is folded onto `luma.com` because Luma redirects one to the other and both are live
 * in the wild — old links and confirmation emails say `lu.ma`, anything copied today says
 * `luma.com`, and they are the same event.
 */
export function canonicalEventKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const outcome = canonicalizeEventUrl(raw);
  if (outcome.kind !== "ok") return null;
  let url: URL;
  try {
    url = new URL(outcome.candidates[0]);
  } catch {
    return null;
  }
  let host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "lu.ma") host = "luma.com";
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return `${host}${path}${url.search}`;
}

/** Every key this candidate can be recognised by, strongest first. */
export function candidateKeys(candidate: DiscoveryCandidate): AliasKey[] {
  const keys: AliasKey[] = [];

  const platform =
    candidate.platform ?? (candidate.url ? platformOf(candidate.url)?.platform ?? null : null);
  const providerEventId =
    candidate.providerEventId ??
    (candidate.url ? platformOf(candidate.url)?.providerEventId ?? null : null);
  if (platform && providerEventId) {
    keys.push({ kind: "provider", value: `${platform}:${providerEventId}` });
  }

  const url = canonicalEventKey(candidate.url);
  if (url) keys.push({ kind: "url", value: url });

  for (const ref of [candidate.sourceRef, ...(candidate.alsoRefs ?? [])]) {
    if (ref) keys.push({ kind: "source_ref", value: ref });
  }
  return keys;
}

export function keyId(key: AliasKey): string {
  return `${key.kind}\u0000${key.value}`;
}

/**
 * Fold a batch of candidates so that two reports of one event become one candidate.
 *
 * Within a single pass this matters more than it sounds: a user whose Google Calendar holds a
 * Luma invite AND whose Luma feed is connected reports the same event twice, seconds apart,
 * with different source refs. Merging them here means one INSERT rather than two racing on
 * the unique index and one of them losing.
 *
 * Union-find over shared keys, because sameness is transitive: a calendar report sharing a URL
 * with a feed report, which shares a provider id with an email report, is all one event even
 * though the first and last have no key in common.
 *
 * The merged candidate keeps the first report's source and the best of everyone's fields — a
 * calendar invite knows the guest list, the feed knows the time zone, the email knows the link.
 */
export function mergeCandidates(candidates: DiscoveryCandidate[]): DiscoveryCandidate[] {
  const parent = new Map<number, number>();
  const find = (i: number): number => {
    let root = i;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(rb, ra);
  };

  const owner = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    parent.set(index, index);
    for (const key of candidateKeys(candidate)) {
      const id = keyId(key);
      const existing = owner.get(id);
      if (existing === undefined) owner.set(id, index);
      else union(existing, index);
    }
  });

  const groups = new Map<number, DiscoveryCandidate[]>();
  candidates.forEach((candidate, index) => {
    const root = find(index);
    const bucket = groups.get(root);
    if (bucket) bucket.push(candidate);
    else groups.set(root, [candidate]);
  });

  return [...groups.values()].map((group) => group.reduce(mergeTwo));
}

function mergeTwo(a: DiscoveryCandidate, b: DiscoveryCandidate): DiscoveryCandidate {
  const attendees = [...a.attendees];
  const seen = new Set(
    attendees.map((person) => (person.email ?? person.fullName ?? "").toLowerCase())
  );
  for (const person of b.attendees) {
    const id = (person.email ?? person.fullName ?? "").toLowerCase();
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    attendees.push(person);
  }

  return {
    // The first report's source wins the badge: it is the one that actually found this event.
    source: a.source,
    sourceRef: a.sourceRef,
    // Every folded report's own key is kept, so each source recognises its own event next
    // time rather than rediscovering it through a weaker key.
    alsoRefs: [...(a.alsoRefs ?? []), b.sourceRef, ...(b.alsoRefs ?? [])].filter(
      (ref, index, all) => ref && ref !== a.sourceRef && all.indexOf(ref) === index
    ),
    url: a.url ?? b.url,
    platform: a.platform ?? b.platform,
    providerEventId: a.providerEventId ?? b.providerEventId,
    title: a.title ?? b.title,
    startsAt: a.startsAt ?? b.startsAt,
    endsAt: a.endsAt ?? b.endsAt,
    timezone: a.timezone ?? b.timezone,
    location: a.location ?? b.location,
    // "Hosted" is the stronger claim and only ever comes from evidence, so it survives a
    // merge with a report that assumed the default.
    roleHint: a.roleHint === "hosted" || b.roleHint === "hosted" ? "hosted" : a.roleHint ?? b.roleHint,
    rsvpHint: a.rsvpHint ?? b.rsvpHint,
    attendees,
    evidence: { ...b.evidence, ...a.evidence },
  };
}
