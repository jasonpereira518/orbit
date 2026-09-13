"use client";

import { useEffect, useId, useState, useTransition } from "react";
import {
  clearBraveKeyAction,
  getResearchSettings,
  saveBraveKeyAction,
  verifyApolloKeyAction,
  type ResearchSettings,
} from "@/actions/outreach-research";
import { SettingsSection } from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";

const ENTRY_LABEL: Record<string, string> = {
  grant: "Granted",
  reserve: "Reserved for a search",
  charge: "Researched a person",
  release: "Returned unused",
  expire: "Expired",
  adjust: "Adjusted",
};

const formatDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function OutreachResearchSettings() {
  const [settings, setSettings] = useState<ResearchSettings | null>(null);
  const [braveKey, setBraveKey] = useState("");
  const [pending, start] = useTransition();
  const braveId = useId();

  useEffect(() => {
    let cancelled = false;
    getResearchSettings()
      .then((value) => {
        if (!cancelled) setSettings(value);
      })
      .catch(() => {
        if (!cancelled) setSettings({ enabled: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!settings || !settings.enabled) return null;
  const { keys, credits, ledger } = settings;

  const reload = async () => setSettings(await getResearchSettings());

  function saveBrave() {
    start(async () => {
      try {
        const result = await saveBraveKeyAction(braveKey);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        setBraveKey("");
        toast.success(result.value.status === "valid" ? "Brave key saved and verified" : "Brave key saved — Brave didn’t answer, so it isn’t verified yet");
        await reload();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t save the Brave key"));
      }
    });
  }

  function removeBrave() {
    start(async () => {
      try {
        const result = await clearBraveKeyAction();
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success("Brave key removed");
        await reload();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t remove the Brave key"));
      }
    });
  }

  function verifyApollo() {
    start(async () => {
      try {
        const result = await verifyApolloKeyAction();
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        const messages = {
          valid: "Apollo key verified",
          invalid: "Apollo didn’t accept the saved key — replace it above",
          unverified: "Apollo didn’t answer — try again in a minute",
          missing: "Save an Apollo key above first",
        } as const;
        const message = messages[result.value.status];
        if (result.value.status === "valid") toast.success(message);
        else toast.message(message);
        await reload();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t check the Apollo key"));
      }
    });
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Research credits"
        description="Finding people is free. Researching a person — work history, a verified email, supporting sources — uses one credit."
        action={<Badge variant="outline">{credits.total} left</Badge>}
      >
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">This month</dt>
            <dd className="text-ink">
              {credits.monthlyAvailable} of {credits.monthlyAllowance}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Lifetime</dt>
            <dd className="text-ink">{credits.lifetimeAvailable}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Refreshes</dt>
            <dd className="text-ink">{formatDate(credits.periodEnd)}</dd>
          </div>
        </dl>
        {ledger.length > 0 && (
          <ul className="divide-y divide-border/60 text-sm">
            {ledger.map((entry) => {
              const amount = entry.amountMonthly + entry.amountLifetime;
              return (
                <li key={entry.id} className="flex items-center justify-between py-1.5">
                  <span className="text-muted-foreground">
                    {ENTRY_LABEL[entry.entryType] ?? entry.entryType} · {formatDate(entry.createdAt)}
                  </span>
                  <span className="tabular-nums text-ink">{amount > 0 ? `+${amount}` : amount}</span>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsSection>

      <SettingsSection
        title="Your own research keys"
        description="Run searches on your own Brave and Apollo accounts instead of Orbit’s allowance. A search on your keys never switches to Orbit’s allowance if a key stops working."
      >
        <div className="space-y-1.5">
          <Label htmlFor={braveId}>Brave Search API key</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={braveId}
              type="password"
              autoComplete="off"
              value={braveKey}
              onChange={(e) => setBraveKey(e.target.value)}
              placeholder={keys.brave.saved ? "Saved — paste to replace" : "From api-dashboard.search.brave.com"}
              className="max-w-sm"
            />
            <Button onClick={saveBrave} disabled={pending || braveKey.trim().length < 10}>
              Save and verify
            </Button>
            {keys.brave.saved && (
              <Button variant="ghost" onClick={removeBrave} disabled={pending}>
                Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {keys.brave.saved ? (keys.brave.verifiedAt ? `Verified ${formatDate(keys.brave.verifiedAt)}` : "Saved, not verified yet") : "Not set"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">
            Apollo key: {keys.apollo.saved ? (keys.apollo.verifiedAt ? `verified ${formatDate(keys.apollo.verifiedAt)}` : "saved, not verified") : "not set (add it in the Outreach section above)"}
          </p>
          {keys.apollo.saved && (
            <Button variant="outline" size="sm" onClick={verifyApollo} disabled={pending}>
              Verify Apollo key
            </Button>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
