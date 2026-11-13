import { ExternalLink } from "lucide-react";
import { CompanyActions, PutBackButton } from "@/components/recruiters/company-actions";
import { Badge } from "@/components/ui/badge";
import { RelativeTime } from "@/components/admin/relative-time";
import { STAGE_LABELS } from "@/lib/recruiter-stages";
import { BOARD_COLUMNS, columnFor, gmailThreadUrl, type BoardCompany } from "@/lib/recruiting-board";

/**
 * The Recruiting board: a card per company, columns in pipeline order. A server component —
 * the only interactive parts are the two controls on each card, which are their own client
 * island.
 */

function CompanyCard({ company }: { company: BoardCompany }) {
  const column = BOARD_COLUMNS.find((c) => c.id === columnFor(company.stage));
  // A column holding two stages says which one; a single-stage column already does.
  const showStage = (column?.stages.length ?? 1) > 1;
  return (
    <li className="min-w-0 rounded-xl border border-border/70 bg-background px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate font-medium text-ink">{company.name}</p>
        <span className="shrink-0 text-xs text-muted-foreground">
          <RelativeTime date={company.lastActivityAt} />
        </span>
      </div>
      {company.roles.length > 0 ? (
        <p className="mt-0.5 truncate text-sm text-muted-foreground">
          {company.roles[0]}
          {company.roles.length > 1 ? ` +${company.roles.length - 1}` : ""}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {showStage ? <Badge variant="secondary">{STAGE_LABELS[company.stage]}</Badge> : null}
        {company.stageSetByYou ? <Badge variant="outline">Set by you</Badge> : null}
      </div>
      {company.summary ? <p className="mt-2 line-clamp-3 text-xs text-foreground">{company.summary}</p> : null}
      <a
        href={gmailThreadUrl(company.threadId)}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Open in Gmail <ExternalLink className="size-3" aria-hidden />
      </a>
      <CompanyActions companyKey={company.key} name={company.name} stage={company.stage} />
    </li>
  );
}

export function CompaniesBoard({ companies, hidden }: { companies: BoardCompany[]; hidden: BoardCompany[] }) {
  const byColumn = new Map(BOARD_COLUMNS.map((c) => [c.id, [] as BoardCompany[]]));
  for (const company of companies) byColumn.get(columnFor(company.stage))?.push(company);
  const closed = byColumn.get("closed") ?? [];

  return (
    <section aria-label="Companies" className="space-y-4">
      {companies.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {BOARD_COLUMNS.filter((c) => c.id !== "closed").map((column) => {
            const items = byColumn.get(column.id) ?? [];
            return (
              <div key={column.id} className="min-w-0 space-y-2">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {column.label} · {items.length}
                </h3>
                {items.length > 0 ? (
                  <ul className="space-y-2">
                    {items.map((company) => (
                      <CompanyCard key={company.key} company={company} />
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-xl border border-dashed border-border/70 px-3 py-4 text-center text-xs text-muted-foreground">
                    None yet
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ) : null}

      {closed.length > 0 ? (
        <details className="rounded-xl border border-border/70 px-4 py-3">
          <summary className="cursor-pointer text-sm text-muted-foreground">Closed · {closed.length}</summary>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {closed.map((company) => (
              <CompanyCard key={company.key} company={company} />
            ))}
          </ul>
        </details>
      ) : null}

      {hidden.length > 0 ? (
        <details className="rounded-xl border border-border/70 px-4 py-3">
          <summary className="cursor-pointer text-sm text-muted-foreground">Not a job · {hidden.length}</summary>
          <ul className="mt-3 space-y-1">
            {hidden.map((company) => (
              <li key={company.key} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-muted-foreground">{company.name}</span>
                <PutBackButton companyKey={company.key} name={company.name} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
