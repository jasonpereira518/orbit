import Link from "next/link";
import { BookOpen } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function KnowledgeSettings() {
  return (
    <section className="space-y-3 rounded-2xl border border-border/70 bg-card p-6">
      <div>
        <h2 className="text-lg font-medium text-primary">Knowledge base</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Browse imported messages, notes, summaries, and key facts Orbit has
          about your network.
        </p>
      </div>
      <Link
        href="/knowledge"
        className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
      >
        <BookOpen />
        Open knowledge base
      </Link>
    </section>
  );
}
