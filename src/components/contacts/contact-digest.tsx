import { digestSourceLine, topicLine, type DigestView } from "@/lib/relationship-engine/digest-copy";

export function DigestSection({ digest }: { digest: DigestView }) {
  const source = digestSourceLine(digest);
  return (
    <div className="space-y-2">
      {digest.whatTheyDo ? <p className="text-sm font-medium text-ink">{digest.whatTheyDo}</p> : null}
      {digest.workingOn ? <p className="text-sm text-muted-foreground">Working on: {digest.workingOn}</p> : null}
      {digest.summary ? <p className="text-sm leading-relaxed text-ink">{digest.summary}</p> : null}
      {digest.topics.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="What you talk about">
          {digest.topics.map((t) => (
            <li key={t.label} title={topicLine(t)} aria-label={topicLine(t)} className="rounded-full border border-border/70 px-2 py-0.5 text-xs text-ink">
              {t.label}
            </li>
          ))}
        </ul>
      ) : null}
      {source ? <p className="text-xs text-muted-foreground">{source}</p> : null}
    </div>
  );
}
