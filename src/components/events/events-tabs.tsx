"use client";

/**
 * Upcoming | Past on the events page.
 *
 * Both lists are rendered on the server and arrive together; this only chooses which one
 * shows. Switching is therefore instant and needs no round trip, and the inactive panel keeps
 * its place (and its scroll-restored images) rather than being thrown away.
 *
 * The opening tab is Upcoming when there is anything coming up, and Past otherwise — a user
 * whose calendar is empty for the next month should land on the events they have been to,
 * not on an empty state.
 */
import { useId, useState } from "react";
import { SegmentedControl, SegmentedPanel } from "@/components/ui/segmented-control";

type TabKey = "upcoming" | "past";

export function EventsTabs({
  upcomingCount,
  pastCount,
  upcoming,
  past,
}: {
  upcomingCount: number;
  pastCount: number;
  upcoming: React.ReactNode;
  past: React.ReactNode;
}) {
  const [tab, setTab] = useState<TabKey>(upcomingCount > 0 || pastCount === 0 ? "upcoming" : "past");
  const id = useId();

  return (
    <div className="space-y-4">
      <SegmentedControl<TabKey>
        id={id}
        ariaLabel="Events"
        value={tab}
        onChange={setTab}
        items={[
          { key: "upcoming", label: "Upcoming", count: upcomingCount },
          { key: "past", label: "Past", count: pastCount },
        ]}
      />
      <SegmentedPanel id={id} value="upcoming" active={tab}>
        {upcoming}
      </SegmentedPanel>
      <SegmentedPanel id={id} value="past" active={tab}>
        {past}
      </SegmentedPanel>
    </div>
  );
}
