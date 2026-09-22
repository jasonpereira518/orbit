/**
 * A page about an organization: who do you know there?
 *
 * People who work there now (by their contact record) and people who did (by
 * their work history). The counts are free on every plan — "you know 4 people
 * at Stripe" is exactly the moment that makes the product click — and the
 * names are Pro, behind the same See plans lock as every Pro section.
 */
import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import type { CompanyLookupResponse, PageContext } from "@contract";
import type { OrbitApi } from "@/lib/api";
import { browser } from "@/lib/browser";
import { APP_URL } from "@/lib/env";
import { unlockFeature } from "@/lib/unlock";
import { Avatar, Meta, MicroLabel, Section } from "../components/ui";

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

export function CompanyView({ page, api }: { page: PageContext; api: OrbitApi }) {
  const org = page.org;
  const [result, setResult] = useState<CompanyLookupResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!org) return;
    const controller = new AbortController();
    setResult(null);
    setFailed(false);
    api
      .company({ org }, controller.signal)
      .then(setResult)
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [org?.name, org, api]);

  if (!org) return null;

  const total = result ? result.currentTotal + result.formerTotal : 0;

  return (
    <div className="scroll-area flex-1">
      <Section hairline={false}>
        {failed ? (
          <Meta>Couldn&apos;t check who you know here.</Meta>
        ) : result === null ? (
          <Meta>Checking who you know at {org.name}…</Meta>
        ) : total === 0 ? (
          <>
            <p className="text-[13px] font-medium leading-snug">No one yet</p>
            <Meta className="mt-0.5">
              Orbit checks where people work now and where they used to.
            </Meta>
          </>
        ) : (
          <>
            <p className="text-[13px] font-medium leading-snug">
              {result.currentTotal > 0
                ? `${people(result.currentTotal)} there now`
                : `No one there now`}
            </p>
            {result.formerTotal > 0 ? (
              <Meta className="mt-0.5">
                and {people(result.formerTotal)} who used to be
              </Meta>
            ) : null}
          </>
        )}
      </Section>

      {result && total > 0 && result.locked ? (
        <Section>
          <div className="flex items-center gap-2">
            <Lock size={13} className="shrink-0 text-[var(--muted-foreground)]" />
            <Meta className="flex-1">Seeing who they are is part of Orbit Pro.</Meta>
            <button
              onClick={() => void unlockFeature(api, "company")}
              className="shrink-0 text-[11px] text-[var(--primary)] hover:underline"
            >
              See plans
            </button>
          </div>
        </Section>
      ) : null}

      {result && result.people.length > 0 ? (
        <Section>
          <MicroLabel className="mb-1">Who you know</MicroLabel>
          <div className="space-y-0.5">
            {result.people.map((person) => (
              <button
                key={person.id}
                onClick={() => browser().openTab(`${APP_URL}/contacts/${person.id}`)}
                className="flex w-full items-center gap-2.5 rounded-[var(--radius)] px-2 py-1.5 text-left hover:bg-[var(--accent)]"
              >
                <Avatar src={person.photoUrl} name={person.fullName} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] leading-[18px]">{person.fullName}</span>
                  <span className="block truncate text-[11px] text-[var(--muted-foreground)]">
                    {person.title ?? "\u00a0"}
                  </span>
                </span>
                <span className="shrink-0 text-[11px] text-[var(--muted-foreground)]">
                  {person.relation === "current" ? "there now" : "formerly"}
                </span>
              </button>
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}
