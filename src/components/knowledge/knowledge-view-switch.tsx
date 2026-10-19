import { SegmentedControl } from "@/components/ui/segmented-control";

const VIEWS = [
  { key: "people" as const, label: "People", href: "/knowledge" },
  { key: "overview" as const, label: "Overview", href: "/knowledge?view=overview" },
];

/**
 * People (the default: a list and a dossier) or Overview (the flat feed of everything).
 * Links rather than state, so each view is a URL, and the choice survives reload and back.
 */
export function KnowledgeViewSwitch({ view }: { view: "people" | "overview" }) {
  return <SegmentedControl items={VIEWS} value={view} ariaLabel="Knowledge view" />;
}
