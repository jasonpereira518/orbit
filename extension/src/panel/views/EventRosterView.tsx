import { useState } from "react";
import { Users } from "lucide-react";
import type { PageContext } from "@contract";
import { APP_URL } from "@/lib/env";
import type { OrbitApi } from "@/lib/api";
import { Notice } from "../components/Notice";
import { Avatar, Button, Meta, MicroLabel } from "../components/ui";

const SITE_LABEL = { luma: "Luma", partiful: "Partiful" } as const;

/**
 * A Luma or Partiful event page: the guest list the user has open, and one Save. Saved guests
 * land on the event in Orbit; none becomes a contact until the user adds them there.
 */
export function EventRosterView({ page, api }: { page: PageContext; api: OrbitApi }) {
  const roster = page.roster!;
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "saving" } | { kind: "saved"; eventId: string; saved: number } | { kind: "error"; message: string }
  >({ kind: "idle" });
  const site = SITE_LABEL[page.site as keyof typeof SITE_LABEL] ?? "the event";

  if (roster.guests.length === 0) {
    return (
      <Notice
        icon={<Users size={18} />}
        title="Open the guest list first"
        body={`Click "Going" (or the guest count) on ${site} so the full list is showing, then click the Orbit icon again.`}
      />
    );
  }

  const save = async () => {
    setState({ kind: "saving" });
    try {
      const result = await api.saveEventRoster(page);
      setState({ kind: "saved", eventId: result.eventId, saved: result.saved });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "Couldn't save the guests." });
    }
  };

  return (
    <div className="scroll-area flex-1 space-y-3 px-3 py-3">
      <div>
        <MicroLabel>Guest list · {site}</MicroLabel>
        <p className="mt-1 text-[14px] font-medium leading-snug">{roster.title || "This event"}</p>
        <Meta>
          {roster.guests.length} {roster.guests.length === 1 ? "person" : "people"} showing
          {page.warnings.includes("roster-truncated") ? " (the first 400)" : ""}
        </Meta>
      </div>

      {state.kind === "saved" ? (
        <div className="space-y-2">
          <Meta>
            Saved {state.saved} {state.saved === 1 ? "guest" : "guests"} to the event. Nobody was added to your
            contacts — pick who to add on the event page.
          </Meta>
          <Button onClick={() => chrome.tabs.create({ url: `${APP_URL}/events/${state.eventId}` })}>
            Open in Orbit
          </Button>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Button onClick={() => void save()} disabled={state.kind === "saving"}>
            {state.kind === "saving" ? "Saving…" : `Save ${roster.guests.length} guests to Orbit`}
          </Button>
          {state.kind === "error" ? (
            <Meta className="text-[var(--destructive)]">{state.message}</Meta>
          ) : (
            <Meta>Names only — Orbit doesn&apos;t add anyone to your contacts.</Meta>
          )}
        </div>
      )}

      <ul className="space-y-1.5">
        {roster.guests.slice(0, 50).map((guest) => (
          <li key={guest.profileUrl ?? guest.name} className="flex items-center gap-2 text-[13px]">
            <Avatar name={guest.name} size={22} />
            <span className="truncate">{guest.name}</span>
          </li>
        ))}
      </ul>
      {roster.guests.length > 50 ? <Meta>…and {roster.guests.length - 50} more</Meta> : null}
    </div>
  );
}
