"use client";
import Link from "next/link";
import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  Mail,
  MessageCircle,
  Plus,
  Search,
  AlertCircle,
  FileText,
} from "lucide-react";
import { formatDistance } from "date-fns";
import type { CampaignSummary } from "@/lib/outreach-v2/overview";
import { Input } from "@/components/ui/input";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EmptyState, Status } from "./outreach-ui";

function nextAction(c: CampaignSummary) {
  if (c.version !== 2) return { label: "View history", view: "" };
  if (c.issues)
    return { label: "Resolve issues", view: "Activity&filter=issues" };
  if (c.unread)
    return { label: "Read replies", view: "Conversations&filter=unread" };
  if (c.drafts) return { label: "Review drafts", view: "Drafts&filter=review" };
  if (c.ready) return { label: "Review & send", view: "Drafts" };
  return c.people
    ? {
        label: c.sent ? "View conversations" : "Select people",
        view: c.sent ? "Conversations" : "People",
      }
    : { label: "Find people", view: "People" };
}
export function OutreachOverview({
  campaigns,
  asOf,
}: {
  campaigns: CampaignSummary[];
  asOf: string;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("active");
  const [attention, setAttention] = useState<
    "unread" | "drafts" | "issues" | null
  >(null);
  const reduced = useReducedMotion();
  const totals = campaigns.reduce(
    (n, c) => ({
      unread: n.unread + c.unread,
      drafts: n.drafts + c.drafts,
      issues: n.issues + c.issues,
    }),
    { unread: 0, drafts: 0, issues: 0 },
  );
  const rows = campaigns
    .filter(
      (c) =>
        (!attention || c[attention] > 0) &&
        (filter === "all" ||
          (filter === "archived"
            ? c.status === "archived"
            : c.status !== "archived")) &&
        `${c.name} ${c.description ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
  return (
    <div className="space-y-8 pb-24">
      <header className="flex flex-wrap items-end justify-between gap-5 md:pr-14">
        <div>
          <h1 className="font-heading text-4xl text-ink">Outreach</h1>
          <p className="mt-2 max-w-xl text-muted-foreground">
            Good relationships start with a conversation.
          </p>
        </div>
        <Link href="/outreach/new" className={buttonVariants()}>
          <Plus size={16} />
          New campaign
        </Link>
      </header>
      <div
        className="flex flex-wrap gap-x-8 gap-y-3 border-y py-4"
        aria-label="Needs attention"
      >
        {(
          [
            { key: "unread", label: "Replies to read", icon: MessageCircle },
            { key: "drafts", label: "Drafts to review", icon: FileText },
            { key: "issues", label: "Sending issues", icon: AlertCircle },
          ] as const
        ).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            aria-pressed={attention === key}
            onClick={() => {
              setAttention(attention === key ? null : key);
              setFilter("all");
            }}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:text-ink",
              attention === key && "bg-accent text-accent-foreground",
            )}
          >
            <Icon size={16} />
            <span className="font-semibold tabular-nums text-ink">
              {totals[key]}
            </span>
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex gap-1 rounded-lg bg-muted p-1"
          aria-label="Campaign filter"
        >
          {["active", "all", "archived"].map((f) => (
            <button
              key={f}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-md px-4 py-2 text-sm capitalize transition-colors",
                filter === f
                  ? "bg-card font-medium text-ink"
                  : "text-muted-foreground hover:text-ink",
              )}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-72">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-3 text-muted-foreground"
          />
          <Input
            className="pl-9"
            aria-label="Search campaigns"
            placeholder="Find a campaign…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      {attention && (
        <p className="text-sm text-muted-foreground">
          Showing campaigns with{" "}
          {attention === "unread"
            ? "unread replies"
            : attention === "drafts"
              ? "drafts awaiting review"
              : "sending issues"}
          .{" "}
          <button className="ml-2 underline" onClick={() => setAttention(null)}>
            Clear attention filter
          </button>
        </p>
      )}
      {!rows.length ? (
        <EmptyState
          title={
            campaigns.length
              ? "No campaigns match"
              : "Who would you like to meet?"
          }
          action={
            !campaigns.length && (
              <Link
                href="/outreach/new"
                className={buttonVariants({ variant: "outline" })}
              >
                Start your first campaign
                <ArrowRight size={16} />
              </Link>
            )
          }
        >
          {campaigns.length
            ? "Try a different search or filter."
            : "Describe the people you want to meet. Orbit helps you find a thoughtful way to start the conversation."}
        </EmptyState>
      ) : (
        <div className="divide-y rounded-xl border bg-card">
          {rows.map((c, i) => {
            const next =
              attention && c.version === 2
                ? {
                    label:
                      attention === "unread"
                        ? "Read replies"
                        : attention === "drafts"
                          ? "Review drafts"
                          : "Resolve issues",
                    view:
                      attention === "unread"
                        ? "Conversations&filter=unread"
                        : attention === "drafts"
                          ? "Drafts&filter=review"
                          : "Activity&filter=issues",
                  }
                : nextAction(c);
            return (
              <motion.div
                key={c.id}
                initial={reduced || i > 5 ? false : { opacity: 0.7, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.24,
                  delay: reduced ? 0 : Math.min(i, 5) * 0.035,
                }}
              >
                <Link
                  href={`/outreach/${c.id}${next.view ? `?view=${next.view}` : ""}`}
                  className="group flex flex-wrap items-center gap-5 p-5 transition-colors hover:bg-muted/35 sm:p-6"
                >
                  <span className="flex size-11 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                    {c.channel === "email" ? (
                      <Mail size={20} />
                    ) : (
                      <MessageCircle size={20} />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-3">
                      <h2 className="text-lg font-medium text-ink">{c.name}</h2>
                      <Status>
                        {c.version !== 2
                          ? "Historical"
                          : c.paused
                            ? "Paused"
                            : c.status === "archived"
                              ? "Archived"
                              : c.drafts
                                ? "Reviewing"
                                : c.sent
                                  ? "In conversation"
                                  : c.people
                                    ? "Discovering"
                                    : "Getting started"}
                      </Status>
                    </div>
                    <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">
                      {c.description || "Your next conversation starts here."}
                    </p>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {c.people} people · {c.sent}{" "}
                      {c.version === 2 ? "confirmed sends" : "sent"}
                      {c.version === 2
                        ? ` · ${c.positive} positive ${c.positive === 1 ? "reply" : "replies"}`
                        : ""}{" "}
                      · Updated{" "}
                      {formatDistance(new Date(c.updatedAt), new Date(asOf), {
                        addSuffix: true,
                      })}
                    </p>
                  </div>
                  <span className="flex items-center gap-2 text-sm font-medium text-primary">
                    {next.label}
                    <ArrowRight
                      size={16}
                      className="transition-transform group-hover:translate-x-1 motion-reduce:transform-none"
                    />
                  </span>
                </Link>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
