import Link from "next/link";
import { ArrowUpRight, MapPin } from "lucide-react";
import type { Person } from "./outreach-workspace-types";
import { Initials, Status } from "./outreach-ui";

export function Evidence({ person }: { person: Person }) {
  return (
    <div className="space-y-5 text-sm">
      <div>
        <h3 className="font-medium text-ink">Why this person</h3>
        <ul className="mt-2 space-y-2 text-muted-foreground">
          {person.research?.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
        {!person.research?.reasons.length && (
          <p className="mt-2 text-muted-foreground">
            Research has not established a match yet.
          </p>
        )}
      </div>
      {!!person.research?.conflicts?.length && (
        <div className="rounded-lg bg-muted p-3">
          <h4 className="font-medium">Conflicting evidence</h4>
          {person.research.conflicts.map((c, i) => (
            <p key={i} className="mt-1">
              {c}
            </p>
          ))}
        </div>
      )}
      <div>
        <h3 className="font-medium text-ink">
          Supporting sources{" "}
          <span className="text-muted-foreground">
            ({person.research?.evidence.length ?? 0})
          </span>
        </h3>
        <ul className="mt-3 space-y-4">
          {person.research?.evidence.map((e, i) => (
            <li key={i}>
              <a
                href={e.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-start gap-1 text-sm underline underline-offset-4"
              >
                {e.title}
                <ArrowUpRight size={13} className="shrink-0" />
              </a>
              <p className="mt-2 break-words text-sm leading-relaxed text-muted-foreground">
                {e.excerpt}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Researched {new Date(e.fetchedAt).toISOString().slice(0, 10)}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
export function PersonHeading({ person }: { person: Person }) {
  return (
    <div className="flex items-start gap-3">
      <Initials name={person.fullName} />
      <div className="min-w-0">
        <h2 className="text-lg font-medium text-ink">{person.fullName}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {person.title || "Role unknown"} ·{" "}
          {person.company || "Organization unknown"}
        </p>
        {person.location && (
          <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
            <MapPin size={12} />
            {person.location}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Status>{person.research?.confidence ?? "low"} confidence</Status>
          {person.research && (
            <Status success={person.research.eligibility === "match"}>
              {person.research.score}% match
            </Status>
          )}
        </div>
        {person.contactId && (
          <Link
            className="mt-3 block text-xs underline"
            href={`/contacts/${person.contactId}`}
          >
            Already in your network
          </Link>
        )}
        {person.research?.priorOutreach && (
          <p className="mt-2 text-xs text-muted-foreground">
            Previously researched or contacted
          </p>
        )}
      </div>
    </div>
  );
}
