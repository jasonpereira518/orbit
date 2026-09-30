import { IntentLink } from "@/components/ui/intent-link";
import { cn } from "@/lib/utils";

const VIEWS = [
  { id: "people", label: "People", href: "/knowledge" },
  { id: "overview", label: "Overview", href: "/knowledge?view=overview" },
] as const;

/**
 * People (the default: a list and a dossier) or Overview (the flat feed of everything).
 * Links rather than state, so each view is a URL, and the choice survives reload and back.
 */
export function KnowledgeViewSwitch({ view }: { view: "people" | "overview" }) {
  return (
    <nav aria-label="Knowledge view" className="inline-flex shrink-0 rounded-xl bg-muted/60 p-1">
      {VIEWS.map((v) => (
        <IntentLink
          key={v.id}
          href={v.href}
          aria-current={view === v.id ? "page" : undefined}
          className={cn(
            "rounded-lg px-3 py-1.5 text-sm transition-colors",
            view === v.id
              ? "bg-card text-ink shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {v.label}
        </IntentLink>
      ))}
    </nav>
  );
}
