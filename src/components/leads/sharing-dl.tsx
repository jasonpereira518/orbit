/**
 * What joining a team shares, and what it never does. Load-bearing, like the recruiter
 * sharing list it copies: this is the only place a person is told what a teammate can learn.
 * Keep it in step with the SELECT lists in `src/lib/leads/warm-path-sql.ts`.
 */
export function SharingDl() {
  return (
    <dl className="grid gap-3 border-t border-border/60 pt-4 text-sm sm:grid-cols-2">
      <div>
        <dt className="font-medium text-foreground">Shared while you share</dt>
        <dd className="mt-1 text-muted-foreground">
          Whether you know someone a teammate looks up, and how close you are &mdash; inner, mid or outer
          orbit &mdash; plus how many other people you know at their company. Your name and work email,
          so they can ask you for the intro.
        </dd>
      </div>
      <div>
        <dt className="font-medium text-foreground">Never shared</dt>
        <dd className="mt-1 text-muted-foreground">
          Your notes, interactions, AI summaries, tags, and anyone&rsquo;s contact details. Teammates
          can&rsquo;t browse your network &mdash; they only learn about someone they already named. People
          you mark &ldquo;Hidden from team&rdquo; never appear, and nothing is shared while sharing is off.
        </dd>
      </div>
    </dl>
  );
}
