"use client";

import { companyBrandText } from "@/lib/company-brand";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import Link from "next/link";
import { IntentLink } from "@/components/ui/intent-link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useGuardedTransition } from "@/lib/single-flight";
import { Plus, Settings } from "lucide-react";
import { toast } from "@/lib/toast";
import { addGoal } from "@/actions/goals";
import type { UserGoal } from "@/db/schema";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PRESS, ROW_HOVER_INSET } from "@/lib/interaction";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";

type GoalAlignedContact = {
  id: string;
  fullName: string;
  preferredName?: string | null;
  company?: string | null;
  title?: string | null;
  /** The client-safe avatar URL the dashboard bundle already hydrates (never the stored base64). */
  profileImageUrl?: string | null;
  goalRelevance: number;
  reason: "target_company" | "goal";
  companyName: string | null;
};

export function GoalsSummary({
  goals,
  goalAlignedContacts,
}: {
  goals: UserGoal[];
  goalAlignedContacts: GoalAlignedContact[];
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, start] = useGuardedTransition();

  const shownGoals = goals.slice(0, 5);

  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle as="h2" className="text-base">Goals</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Surface people aligned with what you&apos;re working toward
          </p>
        </div>
        <Link
          href="/settings"
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5")}
        >
          <Settings className="h-3.5 w-3.5" />
          Manage
        </Link>
      </CardHeader>
      <CardContent className="space-y-5">
        {shownGoals.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Add goals to surface people who match what you&apos;re working toward.{" "}
            <Link href="/settings" className="text-primary underline-offset-4 hover:underline">
              Set up in settings
            </Link>
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {shownGoals.map((g) => (
              <li
                key={g.id}
                className="max-w-full break-words rounded-2xl border border-border/60 bg-muted/40 px-3 py-1.5 text-sm space-y-0.5"
              >
                <div className="font-medium text-foreground">{g.text}</div>
                {g.progress && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" />
                    <span className="line-clamp-1">{g.progress}</span>
                  </div>
                )}
              </li>
            ))}
            {goals.length > 5 && (
              <li className="px-2 py-1 text-xs text-muted-foreground">
                +{goals.length - 5} more
              </li>
            )}
          </ul>
        )}

        <form
          // Capped: a goal is a short phrase, and the input inherited the card's
          // full width — a thousand-pixel field for "raise a seed round".
          className="flex max-w-md gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = text.trim();
            if (!trimmed) return;
            start(async () => {
              try {
                const res = await addGoal(trimmed);
                if (!res.ok) {
                  toast.error(res.error);
                  return;
                }
                setText("");
                toast.success("Goal added");
                router.refresh();
              } catch (err) {
                toast.error(friendlyError(err, "Couldn’t add that goal — try again?"));
              }
            });
          }}
        >
          <Input
            placeholder="Add a goal…"
            aria-label="New goal"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={200}
            disabled={pending}
            className="flex-1"
          />
          <Button type="submit" size="sm" disabled={pending || !text.trim()} className="gap-1">
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </form>

        {goalAlignedContacts.length > 0 && (
          <div className="space-y-2 border-t border-border/60 pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Goal-aligned contacts
            </p>
            {/* Three to a row from `lg` (two from `sm`): a tile is a photo and three short
                lines, which needs about 14rem, so any narrower and the names truncate. */}
            <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {goalAlignedContacts.map((c) => {
                const name = c.preferredName || c.fullName;
                return (
                  <li key={c.id} className="min-w-0">
                    <IntentLink
                      href={`/contacts/${c.id}#follow-up`}
                      className={cn("flex items-center gap-3 px-2 py-2", ROW_HOVER_INSET, PRESS)}
                    >
                      <ContactAvatar
                        contactId={c.id}
                        fullName={name}
                        profileImageUrl={c.profileImageUrl}
                        size="lg"
                        className="shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{name}</span>
                        {(c.title || c.company) && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {c.title}
                            {c.title && c.company ? " · " : ""}
                            {c.company && (
                              <span
                                className={cn("font-medium", companyBrandText(c.company)?.className)}
                                style={companyBrandText(c.company)?.style}
                              >
                                {c.company}
                              </span>
                            )}
                          </span>
                        )}
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          {c.reason === "target_company" && c.companyName
                            ? `Works at ${c.companyName}, one of your targets`
                            : `Matches your goals · ${Math.round(c.goalRelevance * 100)}% match`}
                        </span>
                      </span>
                    </IntentLink>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
