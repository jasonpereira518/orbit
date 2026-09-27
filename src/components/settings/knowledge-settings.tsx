import Link from "next/link";
import { BookOpen } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingsRow } from "@/components/settings/settings-section";

export function KnowledgeSettings() {
  return (
    <SettingsRow
      id="settings-knowledge"
      title="Knowledge base"
      description="Browse imported messages, notes, summaries, and key facts Orbit has about your network."
    >
      <Link
        href="/knowledge"
        className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
      >
        <BookOpen />
        Open knowledge base
      </Link>
    </SettingsRow>
  );
}
