/**
 * Dev builds only: save the page beside the panel as a sanitized test fixture.
 *
 * App renders this behind `import.meta.env.DEV`, which Vite folds to `false`
 * in a production build, so neither this nor the sanitizer ships to the store.
 * (`npm run build` is checked for the sanitizer's marker string.)
 *
 * The flow a fixture takes: open a real page in a signed-in browser, save it
 * here, READ the downloaded file, then commit it under
 * `extension/test/fixtures/<site>/`. The sanitizer refuses outright when it can
 * see a leak; it cannot see a name that nothing on the page links to, which is
 * what the read-before-commit step is for.
 */
import { useState } from "react";
import type { PageContext } from "@contract";
import { browser } from "@/lib/browser";
import { sanitizeFixture, type SanitizeReport } from "@/dev/sanitize-fixture";
import { Button, Meta } from "../components/ui";

type Outcome =
  | { kind: "saved"; file: string; report: SanitizeReport }
  | { kind: "refused"; leaks: string[] }
  | { kind: "failed"; message: string };

function download(filename: string, html: string) {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function FixtureSaver({ page }: { page: PageContext | null }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const save = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      const tab = await browser().activeTab();
      if (!tab?.id || !tab.url) {
        setOutcome({ kind: "failed", message: "Orbit can't read this tab." });
        return;
      }
      const html = await browser().readDocumentHtml(tab.id);
      if (!html) {
        setOutcome({ kind: "failed", message: "The page returned no markup." });
        return;
      }
      const result = sanitizeFixture(html, {
        url: page?.url ?? tab.url,
        names: [
          page?.identity.name?.value,
          ...(page?.candidates ?? []).map((candidate) => candidate.name),
        ],
      });
      if (!result.ok) {
        setOutcome({ kind: "refused", leaks: result.leaks });
        return;
      }
      const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
      const file = `${page?.site ?? "page"}-${page?.kind ?? "unknown"}-${day}.html`;
      download(file, result.html);
      setOutcome({ kind: "saved", file, report: result.report });
    } catch {
      setOutcome({ kind: "failed", message: "Orbit couldn't read this page." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <Meta>
        Saves the page beside the panel with every person pseudonymized, for the
        adapter tests. Read the file before committing it.
      </Meta>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void save()}>
        Save page as fixture
      </Button>
      {outcome?.kind === "saved" ? (
        <Meta>
          Saved {outcome.file}: {outcome.report.people} people renamed,{" "}
          {outcome.report.emails} emails, {outcome.report.proseBlocks} prose
          blocks scrambled.
        </Meta>
      ) : null}
      {outcome?.kind === "refused" ? (
        <Meta className="!text-[var(--destructive)]">
          Not saved — {[...new Set(outcome.leaks)].join(", ")} survived
          sanitizing. Nothing was written.
        </Meta>
      ) : null}
      {outcome?.kind === "failed" ? <Meta>{outcome.message}</Meta> : null}
    </div>
  );
}
