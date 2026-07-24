import { cn } from "@/lib/utils";

/** Static Contacts | Recruiters toggle matching `PeopleViewToggle` chrome. */
export function PeopleViewTogglePreview({
  active,
  hotspotId = "toggle",
}: {
  active: "contacts" | "recruiters";
  hotspotId?: string;
}) {
  return (
    <div
      data-tour-hotspot={hotspotId}
      className="relative flex w-[10.5rem] shrink-0 rounded-lg border border-border/70 bg-card p-0.5 text-[11px] font-medium"
      aria-hidden
    >
      {(["contacts", "recruiters"] as const).map((key) => {
        const selected = active === key;
        return (
          <span
            key={key}
            className={cn(
              "relative flex-1 rounded-md px-2 py-1 text-center",
              selected
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground"
            )}
          >
            {key === "contacts" ? "Contacts" : "Recruiters"}
          </span>
        );
      })}
    </div>
  );
}
