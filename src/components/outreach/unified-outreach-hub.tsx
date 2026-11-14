"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { motion } from "motion/react";
import {
  Compass,
  Layers,
  Plus,
  Send,
  Mail,
  Gauge,
  CheckCircle2,
  Clock,
  ShieldCheck,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FindProspectsSearch } from "@/components/outreach/find-prospects-search";
import { OutreachCampaignCard } from "@/components/outreach/outreach-campaign-card";
import { formatReplyRate } from "@/lib/outreach-metrics";
import { cn } from "@/lib/utils";
import { integrationHref } from "@/components/settings/sections";
import { SPRING_PILL } from "@/lib/motion";
import type { FiveHourQuota } from "@/lib/outreach-types";
import { BrightDataIntegrationGuide } from "@/components/outreach/brightdata-integration-guide";

type Tab = "discover" | "campaigns" | "integrations";

const TABS: Array<{ id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "discover", label: "Find People", icon: Compass },
  { id: "campaigns", label: "Campaigns", icon: Layers },
  { id: "integrations", label: "Email & Sending", icon: Send },
];

export function UnifiedOutreachHub({
  campaigns,
  accountRate,
  totals,
  isBrightDataLive,
  quotaData,
}: {
  campaigns: Array<React.ComponentProps<typeof OutreachCampaignCard>["campaign"]>;
  accountRate: number | null;
  totals: { sent: number; bounced: number; positive: number };
  isBrightDataLive: boolean;
  quotaData?: {
    quota: FiveHourQuota;
    providers: {
      gmail: { connected: boolean; email: string | null };
      outlook: { connected: boolean; email: string | null };
    };
  } | null;
}) {
  const searchParams = useSearchParams();
  const initialTab = (searchParams?.get("tab") as Tab) || "discover";
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);

  const quota = quotaData?.quota;

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
            Outreach
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Find matching people, build research campaigns, and send personal outreach.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {quota && (
            <div className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card px-2.5 py-1.5 text-xs text-muted-foreground shadow-xs">
              <Gauge className="h-3.5 w-3.5 text-primary" />
              <span>Quota:</span>
              <span className="font-semibold text-ink">{quota.remaining}</span>
              <span>/</span>
              <span>{quota.limit} left</span>
            </div>
          )}

          <Link
            href="/outreach/new"
            className={cn(
              buttonVariants({ size: "sm" }),
              "gap-1.5 shadow-xs"
            )}
          >
            <Plus className="h-3.5 w-3.5" />
            New Campaign
          </Link>
        </div>
      </div>

      {/* Segmented View Switcher */}
      <div
        className="relative inline-flex shrink-0 rounded-xl border border-border/70 bg-card p-1 text-sm shadow-xs"
        role="tablist"
        aria-label="Outreach views"
      >
        {TABS.map((tab) => {
          const selected = activeTab === tab.id;
          const count = tab.id === "campaigns" && campaigns.length > 0 ? ` (${campaigns.length})` : "";
          const Icon = tab.icon;

          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "relative z-10 flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors",
                selected
                  ? "text-primary-foreground font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {selected && (
                <motion.span
                  layoutId="outreach-tab-pill"
                  className="absolute inset-0 -z-10 rounded-lg bg-primary shadow-xs"
                  transition={SPRING_PILL}
                />
              )}
              <Icon className="h-3.5 w-3.5" />
              <span>{tab.label}{count}</span>
            </button>
          );
        })}
      </div>

      {/* Tab 1: Find People */}
      {activeTab === "discover" && (
        <div className="reveal-mount">
          <FindProspectsSearch
            campaigns={campaigns.map((c) => ({ id: c.id, name: c.name }))}
            isBrightDataLive={isBrightDataLive}
            onProspectsAdded={() => {
              setActiveTab("campaigns");
            }}
          />
        </div>
      )}

      {/* Tab 2: Campaigns */}
      {activeTab === "campaigns" && (
        <div className="space-y-6 reveal-mount">
          {campaigns.length > 0 && (
            <div className="rounded-2xl border border-border/70 bg-card p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <span className="text-xs font-medium text-muted-foreground">Overall Performance</span>
                  <div className="mt-1 flex flex-wrap items-baseline gap-4">
                    <span className="font-[family-name:var(--font-display)] text-3xl text-ink">
                      {formatReplyRate(accountRate)}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      positive reply rate
                    </span>
                    <span className="text-xs text-muted-foreground-subtle">
                      ({totals.positive} positive · {totals.sent} sent)
                    </span>
                  </div>
                </div>

                <Link
                  href="/outreach/new"
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }), "text-xs gap-1.5")}
                >
                  <Plus className="h-3.5 w-3.5" />
                  New Campaign
                </Link>
              </div>
            </div>
          )}

          {campaigns.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/70 p-12 text-center bg-card/40">
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Layers className="h-5 w-5" />
              </div>
              <h3 className="font-semibold text-ink text-base">No campaigns yet</h3>
              <p className="mt-1 text-sm text-muted-foreground max-w-sm mx-auto">
                Create a campaign to automatically monitor company news, discover matching people, and draft tailored notes.
              </p>
              <div className="mt-4 flex items-center justify-center gap-2">
                <Link
                  href="/outreach/new"
                  className={cn(buttonVariants({ size: "sm" }), "gap-1.5")}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Create Campaign
                </Link>
                <button
                  type="button"
                  onClick={() => setActiveTab("discover")}
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
                >
                  <Compass className="h-3.5 w-3.5" />
                  Find People First
                </button>
              </div>
            </div>
          ) : (
            <div className="grid gap-3.5">
              {campaigns.map((campaign) => (
                <OutreachCampaignCard
                  key={campaign.id}
                  campaign={{
                    id: campaign.id,
                    name: campaign.name,
                    audienceQuery: campaign.audienceQuery,
                    messageIntent: campaign.messageIntent,
                    tone: campaign.tone,
                    defaultChannel: campaign.defaultChannel,
                    status: campaign.status,
                    updatedAt: campaign.updatedAt,
                    metrics: campaign.metrics,
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab 3: Email & Sending */}
      {activeTab === "integrations" && (
        <div className="space-y-6 reveal-mount">
          {/* Email Accounts Card */}
          <div className="rounded-2xl border border-border/70 bg-card p-5 space-y-4">
            <div>
              <h3 className="font-semibold text-ink text-base flex items-center gap-2">
                <Mail className="h-4 w-4 text-primary" />
                Connected Email Inboxes
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Send personal notes and mail merges straight from your real Google or Microsoft address.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              {/* Gmail Box */}
              <div className="rounded-xl border border-border/70 p-4 space-y-2.5 bg-background/50">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm text-ink flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-red-500" />
                    Google Mail (Gmail)
                  </span>
                  {quotaData?.providers.gmail.connected ? (
                    <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 bg-emerald-500/5 text-xs">
                      Connected
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs text-muted-foreground">
                      Not Connected
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground min-h-[1.5rem]">
                  {quotaData?.providers.gmail.email || "Send via your Google Workspace or Gmail account."}
                </p>
                <div className="pt-1">
                  <Link
                    href={integrationHref("google")}
                    className={cn(buttonVariants({ variant: "outline", size: "sm" }), "text-xs w-full")}
                  >
                    Manage Google Connection
                  </Link>
                </div>
              </div>

              {/* Outlook Box */}
              <div className="rounded-xl border border-border/70 p-4 space-y-2.5 bg-background/50">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm text-ink flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-blue-500" />
                    Microsoft 365 / Outlook
                  </span>
                  {quotaData?.providers.outlook.connected ? (
                    <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 bg-emerald-500/5 text-xs">
                      Connected
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs text-muted-foreground">
                      Not Connected
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground min-h-[1.5rem]">
                  {quotaData?.providers.outlook.email || "Send via Microsoft 365 or Outlook Graph API."}
                </p>
                <div className="pt-1">
                  <Link
                    href={integrationHref("microsoft")}
                    className={cn(buttonVariants({ variant: "outline", size: "sm" }), "text-xs w-full")}
                  >
                    Manage Microsoft Connection
                  </Link>
                </div>
              </div>
            </div>
          </div>

          {/* 5-Hour Plan Quota Limits */}
          {quota && (
            <div className="rounded-2xl border border-border/70 bg-card p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="font-semibold text-ink text-base flex items-center gap-2">
                    <Gauge className="h-4 w-4 text-primary" />
                    Send Quota Pacing
                  </h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Sends are spaced in 5-hour rolling windows to maintain sender reputation and protect your inbox from spam flags.
                  </p>
                </div>
                <Badge variant="outline" className="capitalize text-xs">
                  {quota.plan} plan · {quota.remaining} / {quota.limit} available
                </Badge>
              </div>

              {/* Progress bar */}
              <div className="space-y-1.5 pt-1">
                <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all duration-300",
                      quota.remaining === 0 ? "bg-red-500" : quota.remaining < 10 ? "bg-amber-500" : "bg-primary"
                    )}
                    style={{ width: `${Math.min(100, Math.max(4, (quota.used / quota.limit) * 100))}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-2xs text-muted-foreground">
                  <span>{quota.used} sent in current 5-hour window</span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Resets {new Date(quota.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-2">
                {[
                  { plan: "Free", limit: "5 / 5 hrs", current: quota.plan === "free" },
                  { plan: "Orbit Pro", limit: "50 / 5 hrs", current: quota.plan === "orbit" },
                  { plan: "Orbit Max", limit: "250 / 5 hrs", current: quota.plan === "max" },
                  { plan: "Lifetime", limit: "250 / 5 hrs", current: quota.plan === "lifetime" },
                ].map((tier) => (
                  <div
                    key={tier.plan}
                    className={cn(
                      "rounded-xl border p-3 text-xs transition",
                      tier.current
                        ? "border-primary bg-primary/5 shadow-xs"
                        : "border-border/60 bg-muted/20 text-muted-foreground"
                    )}
                  >
                    <span className="font-semibold text-ink block">{tier.plan}</span>
                    <p className="mt-0.5 font-medium">{tier.limit}</p>
                    {tier.current && (
                      <span className="inline-block mt-1.5 text-3xs font-semibold text-primary">
                        Your Plan
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Web Scraping & Profile Search Card */}
          <div className="rounded-2xl border border-border/70 bg-card p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold text-ink text-base flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                  Web & LinkedIn Search Engine
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Powered by BrightData Web Unlocker with 14-day deduplication cache.
                </p>
              </div>
              <BrightDataIntegrationGuide isConfigured={isBrightDataLive} />
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                {isBrightDataLive ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    <span className="text-ink font-medium">Live Scraping Active</span>
                  </>
                ) : (
                  <>
                    <span className="h-2 w-2 rounded-full bg-amber-500" />
                    <span>Preview Scraper Mode</span>
                  </>
                )}
              </span>
              <span>·</span>
              <span>14-day automatic caching (zero duplicate cost)</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
