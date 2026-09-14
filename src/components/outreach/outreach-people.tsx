"use client";
import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Mail,
  RefreshCw,
  Search,
} from "lucide-react";
import * as actions from "@/actions/outreach-v2";
import type { Brief } from "@/lib/outreach-v2/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ActionBar, SplitView, ListRow, Status } from "./outreach-ui";
import { Evidence, PersonHeading } from "./outreach-evidence";
import { ResearchSettings } from "./outreach-v2-setup";
import { AudienceCriteria } from "./outreach-v2-audience";
import {
  appendNewPeople,
  type Workspace,
  type Act,
} from "./outreach-workspace-types";
export function OutreachPeople({
  data,
  pending,
  act,
  setTab,
  initialFunding,
}: {
  data: Workspace;
  pending: boolean;
  act: Act;
  setTab: (tab: string) => void;
  initialFunding: "hosted" | "personal";
}) {
  const id = data.campaign.id;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activePerson, setActivePerson] = useState<string | null>(null);
  const [order, setOrder] = useState(data.people.map((p) => p.id));
  const [instructions, setInstructions] = useState("");
  const [brief, setBrief] = useState<Brief>(data.campaign.brief!);
  const [funding, setFunding] = useState(initialFunding);
  const [limit, setLimit] = useState(50);
  const incomingOrder = appendNewPeople(
    order,
    data.people.map((p) => p.id),
  );
  if (
    incomingOrder.length !== order.length ||
    incomingOrder.some((id, i) => id !== order[i])
  )
    setOrder(incomingOrder);
  const orderedPeople = useMemo(() => {
    const currentOrder = appendNewPeople(
      order,
      data.people.map((p) => p.id),
    );
    const positions = new Map(currentOrder.map((id, i) => [id, i]));
    return [...data.people].sort(
      (a, b) =>
        (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity),
    );
  }, [data.people, order]);
  const rankingsChanged = data.people.some((p, i) => order[i] !== p.id);
  const people = useMemo(
    () =>
      orderedPeople.filter(
        (p) =>
          [p.fullName, p.title, p.company]
            .join(" ")
            .toLowerCase()
            .includes(query.toLowerCase()) &&
          p.status !== "skipped" &&
          (filter === "all" ||
            (filter === "reachable" &&
              (data.campaign.defaultChannel === "email"
                ? p.email
                : p.linkedinUrl)) ||
            (filter === "strong" && p.research?.eligibility === "match") ||
            (filter === "selected" && selected.has(p.id))),
      ),
    [orderedPeople, data.campaign.defaultChannel, filter, query, selected],
  );
  const pages = Math.max(1, Math.ceil(people.length / 20));
  const current = Math.min(page, pages - 1);
  const visible = people.slice(current * 20, current * 20 + 20);
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="space-y-5">
      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer font-medium">
          Audience & research
        </summary>
        <div className="mt-5 space-y-5">
          <AudienceCriteria value={brief} onChange={setBrief} />
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              act(
                () =>
                  actions.saveOutreachAudience(id, {
                    ...brief,
                    confirmed: true,
                  }),
                "Audience saved and results reranked.",
              )
            }
          >
            Confirm criteria & rerank
          </Button>
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-2 text-sm">
              <span className="block">Funding source</span>
              <select
                className="rounded-md border bg-background p-2"
                value={funding}
                onChange={(e) =>
                  setFunding(e.target.value as "hosted" | "personal")
                }
              >
                <option value="hosted">
                  Orbit allowance ({data.settings.credits.remaining} remaining)
                </option>
                <option value="personal">My Brave + Apollo keys</option>
              </select>
            </label>
            <label className="space-y-2 text-sm">
              <span className="block">People to research</span>
              <Input
                type="number"
                min={1}
                max={100}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                className="w-24"
              />
            </label>
            <Button
              disabled={pending}
              onClick={() =>
                act(
                  () => actions.searchOutreachPeople(id, funding, limit),
                  "Research queued. Results will appear as people are researched.",
                )
              }
            >
              <Search size={16} />
              Find people
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Up to {limit} research credits. Missing information stays marked
            unknown. Search and enrichment use only the selected funding source.
          </p>
        </div>
      </details>
      {!data.people.length ? (
        <div className="py-12 text-center">
          <Search className="mx-auto mb-4 text-muted-foreground" size={28} />
          <h2 className="text-lg font-medium">Find the people worth meeting</h2>
          <p className="mx-auto mt-2 max-w-md text-muted-foreground">
            Confirm your audience above, then start research. Each result will
            explain why the person fits and link to its sources.
          </p>
          <Button
            className="mt-5"
            disabled={pending}
            onClick={() =>
              act(
                () => actions.searchOutreachPeople(id, funding, limit),
                "Research started.",
              )
            }
          >
            Find people
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              className="max-w-sm"
              aria-label="Search people"
              placeholder="Search names, roles, companies…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
            <select
              aria-label="Filter people"
              className="rounded-md border bg-background p-2 text-sm"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(0);
              }}
            >
              <option value="all">All results</option>
              <option value="strong">Matches criteria</option>
              <option value="reachable">Has contact details</option>
              <option value="selected">Selected</option>
            </select>
            <span className="text-sm text-muted-foreground">
              {people.length} matching
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={
                  visible.length > 0 && visible.every((p) => selected.has(p.id))
                }
                onChange={(e) =>
                  setSelected((s) => {
                    const next = new Set(s);
                    visible.forEach((p) =>
                      e.target.checked ? next.add(p.id) : next.delete(p.id),
                    );
                    return next;
                  })
                }
              />
              Select this page ({visible.length})
            </label>
            <button
              className="underline"
              onClick={() => setSelected(new Set(people.map((p) => p.id)))}
            >
              Select all {people.length} matching results
            </button>
            <button
              className="text-muted-foreground underline"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
            <span>{selected.size} selected</span>
          </div>
          {rankingsChanged && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOrder(data.people.map((p) => p.id))}
            >
              <RefreshCw size={14} />
              Apply updated rankings
            </Button>
          )}
          <SplitView
            active={activePerson !== null}
            onBack={() => setActivePerson(null)}
            label="people"
            list={
              <ul className="divide-y">
                {visible.map((p) => (
                  <li key={p.id} className="flex items-start">
                    <input
                      className="ml-4 mt-5 size-4 shrink-0 accent-primary"
                      aria-label={`Select ${p.fullName}`}
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggle(p.id)}
                    />
                    <ListRow
                      name={p.fullName}
                      detail={`${p.title ?? "Role unknown"} · ${p.company ?? "Organization unknown"}`}
                      active={(activePerson ?? visible[0]?.id) === p.id}
                      onClick={() => setActivePerson(p.id)}
                      trailing={
                        <span className="text-xs text-muted-foreground">
                          {p.research?.score ?? 0}% match ·{" "}
                          {data.campaign.defaultChannel === "email"
                            ? p.email
                              ? "Email available"
                              : "Email missing"
                            : p.linkedinUrl
                              ? "LinkedIn available"
                              : "Profile missing"}
                        </span>
                      }
                    />
                  </li>
                ))}
              </ul>
            }
          >
            {(() => {
              const p = people.find((p) => p.id === activePerson) ?? visible[0];
              return p ? (
                <div className="space-y-6 p-5 sm:p-6">
                  <PersonHeading person={p} />
                  <div className="flex flex-wrap items-center gap-3 border-y py-4 text-sm">
                    <span className="break-all">
                      {p.email || "Email unavailable"}
                    </span>
                    <Status>{p.research?.emailStatus ?? "unknown"}</Status>
                    {p.linkedinUrl && (
                      <a
                        className="inline-flex items-center gap-1 underline"
                        href={p.linkedinUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        LinkedIn
                        <ArrowUpRight size={13} />
                      </a>
                    )}
                    {!p.contactId && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() =>
                          act(
                            () => actions.saveOutreachPerson(p.id),
                            "Person saved to contacts.",
                          )
                        }
                      >
                        Save to contacts
                      </Button>
                    )}
                  </div>
                  {p.research?.ambiguous && (
                    <label className="block space-y-2 text-sm">
                      <span className="font-medium">Identity needs review</span>
                      <select
                        className="block w-full rounded-lg border bg-background p-2"
                        aria-label={`Resolve identity for ${p.fullName}`}
                        value=""
                        onChange={(e) =>
                          act(
                            () =>
                              actions.resolveOutreachIdentity(
                                p.id,
                                e.target.value === "different"
                                  ? null
                                  : e.target.value,
                              ),
                            "Identity reviewed.",
                          )
                        }
                      >
                        <option value="" disabled>
                          Choose the correct identity
                        </option>
                        {p.identityChoices.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.fullName} ·{" "}
                            {c.email ?? c.linkedinUrl ?? "existing contact"}
                          </option>
                        ))}
                        <option value="different">
                          This is a different person
                        </option>
                      </select>
                    </label>
                  )}
                  <Evidence person={p} />
                </div>
              ) : (
                <div className="p-10 text-center text-sm text-muted-foreground">
                  No people match your filters.
                </div>
              );
            })()}
          </SplitView>
          <div className="flex justify-between text-sm">
            <span>
              Page {current + 1} of {pages}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={current === 0}
                onClick={() => setPage(current - 1)}
                aria-label="Previous page"
              >
                <ChevronLeft size={16} />
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={current + 1 >= pages}
                onClick={() => setPage(current + 1)}
                aria-label="Next page"
              >
                <ChevronRight size={16} />
              </Button>
            </div>
          </div>
          {selected.size > 0 && (
            <ActionBar>
              <label className="min-w-56 flex-1 text-sm">
                Instructions for this batch
                <Input
                  className="mt-2"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="Keep it warm and ask for a 15-minute conversation"
                />
              </label>
              <Button
                disabled={pending}
                onClick={() =>
                  act(async () => {
                    await actions.draftOutreachMessages(
                      id,
                      [...selected],
                      instructions,
                    );
                    setTab("Drafts");
                  }, "Drafts queued.")
                }
              >
                <Mail size={16} />
                Draft for {selected.size}
              </Button>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() =>
                  act(async () => {
                    await actions.updateOutreachPeople(
                      id,
                      [...selected],
                      "skipped",
                    );
                    setSelected(new Set());
                  }, "Selected people excluded.")
                }
              >
                Exclude
              </Button>
            </ActionBar>
          )}
        </>
      )}
      <ResearchSettings settings={data.settings} />
    </div>
  );
}
