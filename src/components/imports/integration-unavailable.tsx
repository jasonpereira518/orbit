"use client";

/**
 * Placeholder for an integration whose credentials this deployment does not have.
 *
 * The env-var names it takes are for whoever is running the app, not for the person
 * looking at the page: a visitor reading "Set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET
 * and MICROSOFT_REDIRECT_URI to enable this" learns only that something is unfinished.
 * They get the plain sentence; the setup line is compiled out of production bundles by
 * the NODE_ENV check.
 */
export function IntegrationUnavailable({
  title,
  blurb,
  envVars = [],
}: {
  title: string;
  blurb: string;
  envVars?: string[];
}) {
  return (
    <section className="space-y-2 rounded-2xl border border-dashed border-border/70 bg-card/50 p-6">
      <h2 className="text-lg font-medium text-ink">{title}</h2>
      <p className="text-sm text-muted-foreground">{blurb}</p>
      {process.env.NODE_ENV === "development" && envVars.length > 0 ? (
        <p className="text-xs text-muted-foreground/70">
          Dev only — set {envVars.join(", ")} to enable.
        </p>
      ) : null}
    </section>
  );
}
