"use client";

/**
 * Where the user is trying to get, and where they studied.
 *
 * Orbit knows a great deal about who the user HAS met and almost nothing about who they are
 * trying to meet. Goals carry some of it in prose and `goalRelevanceComponent` token-matches
 * against that — which cannot tell "I want to work at Stripe" from "we use Stripe".
 *
 * Two short lists close the gap, and they are the highest-signal input event ranking has: at a
 * fair with thirty booths, "three of these are on your list" is the whole answer.
 */
import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import {
  deleteTargetCompany,
  saveSchools,
  saveTargetCompany,
} from "@/actions/target-companies";
import type { TargetCompanyRow, TargetPriority } from "@/lib/events/target-companies";
import { SettingsRow, SettingsSection } from "@/components/settings/settings-section";

const PRIORITY_LABEL: Record<TargetPriority, string> = {
  1: "Dream",
  2: "Target",
  3: "Curious",
};

/** `items` so the trigger shows "Dream", not the stored "1". */
const PRIORITY_ITEMS = ([1, 2, 3] as const).map((p) => ({
  value: String(p),
  label: PRIORITY_LABEL[p],
}));

export function TargetCompaniesSettings({
  initialCompanies,
  initialSchools,
}: {
  initialCompanies: TargetCompanyRow[];
  initialSchools: string[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [priority, setPriority] = useState<TargetPriority>(2);
  const [school, setSchool] = useState("");
  // Shown under the row and tied to its field until the next attempt; a toast alone could
  // time out unread.
  const [companyError, setCompanyError] = useState<string | null>(null);
  const [schoolError, setSchoolError] = useState<string | null>(null);
  const companyRef = useRef<HTMLInputElement>(null);
  const companyErrorId = useId();
  const schoolErrorId = useId();

  function add() {
    if (!name.trim()) return;
    setCompanyError(null);
    start(async () => {
      const result = await saveTargetCompany(name, priority);
      if (!result.ok) {
        setCompanyError(result.error ?? "Couldn’t add that company");
        companyRef.current?.focus();
        return;
      }
      setName("");
      toast.success(`${name.trim()} added`);
      router.refresh();
    });
  }

  function remove(id: string, label: string) {
    start(async () => {
      try {
        await deleteTargetCompany(id);
        toast.success(`${label} removed`);
        router.refresh();
      } catch (error) {
        toast.error(friendlyError(error, "Couldn’t remove that — try again?"));
      }
    });
  }

  function addSchool() {
    if (!school.trim()) return;
    setSchoolError(null);
    start(async () => {
      try {
        await saveSchools([...initialSchools, school]);
        setSchool("");
        router.refresh();
      } catch (error) {
        const message = friendlyError(error, "Couldn’t save that — try again?");
        toast.error(message);
        setSchoolError(message);
      }
    });
  }

  function removeSchool(value: string) {
    start(async () => {
      await saveSchools(initialSchools.filter((item) => item !== value));
      router.refresh();
    });
  }

  return (
    <SettingsSection
      title="Target companies and schools"
      description="Orbit uses these to rank who is worth talking to at an event — and to tell you when somewhere you are aiming at turns up on a guest list."
    >

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            ref={companyRef}
            value={name}
            aria-invalid={companyError ? true : undefined}
            aria-describedby={companyError ? companyErrorId : undefined}
            onChange={(e) => {
              setName(e.target.value);
              if (companyError) setCompanyError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
            placeholder="Company name"
            aria-label="Company name"
            className="max-w-xs"
          />
          <Select
            value={String(priority)}
            onValueChange={(v) => setPriority(Number(v ?? 2) as TargetPriority)}
            items={PRIORITY_ITEMS}
          >
            <SelectTrigger aria-label="How much you want it" className="h-9 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} className="p-1">
              {PRIORITY_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value} className="py-1.5 pl-2">
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={add} disabled={pending || !name.trim()}>
            <Star className="size-4" aria-hidden />
            Add
          </Button>
        </div>
        <FormError id={companyErrorId}>{companyError}</FormError>

        {initialCompanies.length === 0 ? (
          <p className="text-sm text-muted-foreground">No target companies yet.</p>
        ) : (
          <ul className="space-y-2">
            {initialCompanies.map((company) => (
              <li
                key={company.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-border/60 px-3 py-2"
              >
                <span className="min-w-0 truncate text-sm">
                  {company.name}
                  <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-2xs text-muted-foreground">
                    {PRIORITY_LABEL[company.priority]}
                  </span>
                  {/* The useful part: a target you already have a way into. */}
                  {company.contactCount > 0 ? (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {company.contactCount} contact{company.contactCount === 1 ? "" : "s"} there
                    </span>
                  ) : null}
                </span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => remove(company.id, company.name)}
                  aria-label={`Remove ${company.name}`}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <SettingsRow
        title="Schools"
        description="A shared alma mater is the easiest opening line there is, so it counts toward who to find at an event."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={school}
            aria-invalid={schoolError ? true : undefined}
            aria-describedby={schoolError ? schoolErrorId : undefined}
            onChange={(e) => {
              setSchool(e.target.value);
              if (schoolError) setSchoolError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") addSchool();
            }}
            placeholder="University of North Carolina"
            aria-label="School"
            className="max-w-xs"
          />
          <Button variant="outline" onClick={addSchool} disabled={pending || !school.trim()}>
            Add
          </Button>
        </div>
        <FormError id={schoolErrorId} className="mt-2">{schoolError}</FormError>
        {initialSchools.length > 0 ? (
          <ul className="flex flex-wrap gap-2 pt-1">
            {initialSchools.map((item) => (
              <li
                key={item}
                className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-xs"
              >
                {item}
                <button
                  type="button"
                  onClick={() => removeSchool(item)}
                  disabled={pending}
                  aria-label={`Remove ${item}`}
                  className="relative -my-0.5 -mr-1 grid size-6 tap-target place-items-center rounded-full text-muted-foreground hover:text-foreground"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
