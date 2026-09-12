"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Filter state lives in the URL, so any view is linkable and the back button works. */
export function ContactsFilterBar({ userId, q }: { userId: string; q: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const push = (nextQ: string) => {
    const params = new URLSearchParams();
    if (nextQ) params.set("contactsQ", nextQ);
    // A changed search invalidates the current page number: staying on page 4 of a result
    // set that just shrank to one page shows an empty table and reads as "no matches".
    const query = params.toString();
    startTransition(() => {
      router.push(
        `/admin/users/${encodeURIComponent(userId)}${query ? `?${query}` : ""}#contacts`
      );
    });
  };

  return (
    <div
      className={cn(
        "relative max-w-xs flex-1 transition-opacity duration-fast",
        pending && "opacity-60"
      )}
    >
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        defaultValue={q}
        placeholder="Search name, company or title…"
        aria-label="Search contacts"
        className="h-8 pl-8 text-sm"
        onKeyDown={(e) => {
          if (e.key === "Enter") push(e.currentTarget.value);
        }}
        onBlur={(e) => {
          if (e.currentTarget.value !== q) push(e.currentTarget.value);
        }}
      />
    </div>
  );
}
