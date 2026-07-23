import Link from "next/link";
import { RecruiterLogForm } from "@/components/recruiters/recruiter-log-form";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function NewRecruiterPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">
            Log a recruiter
          </h1>
          <p className="mt-1 text-muted-foreground">
            Adds them to the shared directory. Your notes and rating stay
            private.
          </p>
        </div>
        <Link
          href="/recruiters"
          className={cn(buttonVariants({ variant: "outline" }))}
        >
          Back
        </Link>
      </div>
      <div className="rounded-2xl border border-border/70 bg-card p-5">
        <RecruiterLogForm />
      </div>
    </div>
  );
}
