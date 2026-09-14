"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { OutreachActivity } from "./outreach-activity";
import { OutreachConversations } from "./outreach-conversations";
import { DraftList, SendReview } from "./outreach-drafts";
import { OutreachPeople } from "./outreach-people";
import { ActionBar, spring } from "./outreach-ui";
import {
  draftIsDirty,
  isReviewable,
  type DraftEdit,
  type DraftEdits,
} from "./outreach-workspace-types";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Pause,
  Play,
  RefreshCw,
  Send,
} from "lucide-react";
import * as actions from "@/actions/outreach-v2";
import type { snapshot } from "@/lib/outreach-v2/service";
import { followUpDue } from "@/lib/outreach-v2/policy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
type Workspace = Awaited<ReturnType<typeof snapshot>>;
const statusLabel = (s: string) => s.replaceAll("_", " ");
export function OutreachWorkspace({ initial }: { initial: Workspace }) {
  const searchParams = useSearchParams();
  const reduced = useReducedMotion();
  const [activeDraft, setActiveDraft] = useState<string | null>(null);
  const [activeConversation, setActiveConversation] = useState<string | null>(
    null,
  );
  const [conversationFilter, setConversationFilter] = useState(
    searchParams.get("view") === "Conversations"
      ? (searchParams.get("filter") ?? "all")
      : "all",
  );
  const [issuesOnly, setIssuesOnly] = useState(
    searchParams.get("view") === "Activity" &&
      searchParams.get("filter") === "issues",
  );
  const [draftFilter, setDraftFilter] = useState(
    searchParams.get("view") === "Drafts"
      ? (searchParams.get("filter") ?? "all")
      : "all",
  );
  const [edits, setEdits] = useState<DraftEdits>({});
  const editDraft = (id: string, edit: DraftEdit | undefined) =>
    setEdits((current) => {
      const next = { ...current };
      if (edit) next[id] = edit;
      else delete next[id];
      return next;
    });
  const [data, setData] = useState(initial),
    [tab, updateTab] = useState(
      ["People", "Drafts", "Conversations", "Activity"].includes(
        searchParams.get("view") ?? "",
      )
        ? searchParams.get("view")!
        : "People",
    ),
    [draftIds, setDraftIds] = useState<Set<string>>(new Set()),
    [instructions, setInstructions] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [pending, start] = useTransition(),
    [unverified, setUnverified] = useState(false),
    [sendReview, setSendReview] = useState(false);
  const id = data.campaign.id;
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef<Record<string, number>>({});
  const setTab = (next: string) => {
    const scroller = rootRef.current?.closest("main");
    if (scroller) scrollPositions.current[tab] = scroller.scrollTop;
    updateTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("view", next);
    url.searchParams.delete("filter");
    window.history.replaceState(null, "", url);
    requestAnimationFrame(() => {
      if (scroller) scroller.scrollTop = scrollPositions.current[next] ?? 0;
    });
  };
  const refresh = useCallback(async () => {
    const incoming = await actions.getOutreachWorkspace(id);
    setData(incoming);
  }, [id]);
  useEffect(() => {
    const timer = setInterval(() => {
      void refresh().catch(() =>
        setError(
          "Campaign updates are unavailable. Refresh to reconnect; your edits are preserved.",
        ),
      );
    }, 7000);
    return () => clearInterval(timer);
  }, [refresh]);
  const act = (fn: () => Promise<unknown>, success?: string) => {
    setError("");
    setNotice("");
    start(async () => {
      try {
        await fn();
        await refresh();
        if (success) setNotice(success);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Something went wrong. Try again.",
        );
      }
    });
  };
  const messages = data.people.flatMap((p) =>
    p.messages.map((m) => ({ ...m, person: p })),
  );
  const drafts = messages.filter(
    (m) =>
      m.channel === data.campaign.defaultChannel &&
      m.person.status !== "skipped" &&
      isReviewable(m),
  );
  const dirtyIds = new Set(
    drafts.filter((m) => draftIsDirty(m, edits[m.id])).map((m) => m.id),
  );
  const visibleDrafts = drafts.filter(
    (m) =>
      draftFilter === "all" ||
      (draftFilter === "review"
        ? dirtyIds.has(m.id) || m.approvedRevision !== m.revision
        : !dirtyIds.has(m.id) && m.approvedRevision === m.revision),
  );
  const chosen = drafts.filter((m) => draftIds.has(m.id));
  const toggleDraft = (id: string) =>
    setDraftIds((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const counts = {
    sent: messages.filter((m) => m.executionStatus === "confirmed").length,
    accepted: data.conversations.filter((c) => c.acceptedAt).length,
    replied: data.conversations.filter((c) => c.lastHumanReplyAt).length,
    positive: data.conversations.filter((c) => c.outcome === "positive_reply")
      .length,
    unread: data.conversations.filter((c) => c.unread).length,
    pending:
      data.campaign.defaultChannel === "linkedin"
        ? data.conversations.filter(
            (c) =>
              !c.acceptedAt &&
              messages.some(
                (m) =>
                  m.prospectId === c.prospectId &&
                  m.executionStatus === "confirmed",
              ),
          ).length
        : 0,
  };
  const due = data.conversations.filter(
    (c) =>
      !messages.some(
        (m) =>
          m.prospectId === c.prospectId &&
          m.messageKind === "follow_up" &&
          [
            "idle",
            "queued",
            "sending",
            "accepted",
            "needs_verification",
          ].includes(m.executionStatus),
      ) &&
      followUpDue({
        channel: data.campaign.defaultChannel ?? "email",
        sentAt:
          messages
            .filter((m) => m.prospectId === c.prospectId && m.sentAt)
            .sort(
              (a, b) =>
                new Date(b.sentAt!).getTime() - new Date(a.sentAt!).getTime(),
            )[0]?.sentAt ?? null,
        acceptedAt: c.acceptedAt,
        lastHumanReplyAt: c.lastHumanReplyAt,
        closed: c.closed,
        optedOut: c.optedOut,
        now: data.asOf,
      }),
  );
  const previousProgress = useRef({
    sent: counts.sent,
    research: data.jobs.filter(
      (j) => j.kind === "search" && j.status === "completed",
    ).length,
  });
  useEffect(() => {
    const research = data.jobs.filter(
      (j) => j.kind === "search" && j.status === "completed",
    ).length;
    if (counts.sent > previousProgress.current.sent)
      setNotice(`${counts.sent} messages confirmed sent.`);
    else if (research > previousProgress.current.research)
      setNotice("Research complete. Your results are ready to explore.");
    previousProgress.current = { sent: counts.sent, research };
  }, [counts.sent, data.jobs]);
  return (
    <div ref={rootRef} className="space-y-5 pb-28">
      <header className="flex flex-wrap items-start justify-between gap-4 md:pr-14">
        <div>
          <Link
            href="/outreach"
            className="text-sm text-muted-foreground hover:underline"
          >
            All campaigns
          </Link>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl text-ink">
            {data.campaign.name}
          </h1>
          <p className="mt-2 line-clamp-2 max-w-2xl text-sm text-muted-foreground">
            {data.campaign.brief?.description}
          </p>
          <p className="mt-3 break-all text-xs text-muted-foreground">
            {data.campaign.defaultChannel === "email" ? "Email" : "LinkedIn"} ·{" "}
            {data.campaign.sender?.address} ·{" "}
            {statusLabel(data.campaign.sender?.transport ?? "")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              if (counts.unread) {
                setConversationFilter("unread");
                setTab("Conversations");
              } else if (drafts.length) setTab("Drafts");
              else {
                setTab("People");
                rootRef.current
                  ?.querySelector("details")
                  ?.setAttribute("open", "");
              }
            }}
          >
            {counts.unread
              ? "Read replies"
              : drafts.length
                ? "Review drafts"
                : "Find people"}
            <ChevronRight size={15} />
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              act(() =>
                actions.pauseOutreachCampaign(id, !data.campaign.paused),
              )
            }
          >
            {data.campaign.paused ? <Play size={16} /> : <Pause size={16} />}{" "}
            {data.campaign.paused ? "Resume" : "Pause"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => act(refresh)}
            aria-label="Refresh campaign"
          >
            <RefreshCw size={16} />
          </Button>
        </div>
      </header>
      <div className="flex flex-wrap gap-x-6 gap-y-2 border-y py-3 text-xs text-muted-foreground [&_strong]:font-semibold [&_strong]:text-ink">
        <span>
          <strong>{data.people.length}</strong> people
        </span>
        <span>
          <strong>{counts.sent}</strong> sent
        </span>
        {data.campaign.defaultChannel === "linkedin" && (
          <>
            <span>
              <strong>{counts.pending}</strong> pending invitations
            </span>
            <span>
              <strong>{counts.accepted}</strong> accepted
            </span>
          </>
        )}
        <span>
          <strong>{counts.replied}</strong> replied
        </span>
        <span>
          <strong>{counts.positive}</strong> positive
        </span>
        <span>
          <strong>{due.length}</strong> follow-ups due
        </span>
      </div>
      {counts.unread > 0 && (
        <button
          className="flex w-full items-center justify-between rounded-lg bg-accent px-4 py-3 text-left text-accent-foreground"
          onClick={() => setTab("Conversations")}
        >
          <span>
            {counts.unread}{" "}
            {counts.unread === 1 ? "conversation needs" : "conversations need"}{" "}
            your attention
          </span>
          <ArrowUpRight size={18} />
        </button>
      )}
      {data.jobs.some((j) =>
        ["queued", "running", "needs_verification", "failed"].includes(
          j.status,
        ),
      ) && (
        <button
          onClick={() => setTab("Activity")}
          className="flex w-full items-center justify-between gap-3 rounded-xl bg-muted/60 px-4 py-3 text-left text-sm"
        >
          <span className="flex items-center gap-2">
            <RefreshCw
              size={15}
              className={
                data.jobs.some((j) => j.status === "running") && !reduced
                  ? "animate-spin"
                  : ""
              }
            />
            {data.campaign.paused
              ? "Campaign paused"
              : `${data.jobs.filter((j) => ["queued", "running"].includes(j.status)).length} actions in progress`}
            <span className="text-muted-foreground">
              · {counts.sent} confirmed sends
            </span>
          </span>
          <span className="flex items-center gap-1">
            View activity
            <ChevronRight size={15} />
          </span>
        </button>
      )}
      <nav
        className="flex gap-1 overflow-x-auto border-b"
        aria-label="Campaign views"
      >
        {["People", "Drafts", "Conversations", "Activity"].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            aria-current={tab === t ? "page" : undefined}
            className={`relative shrink-0 px-4 py-3 text-sm transition-colors ${tab === t ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {t}
            <span className="ml-2 text-xs tabular-nums text-muted-foreground">
              {t === "Drafts"
                ? drafts.length
                : t === "People"
                  ? data.people.length
                  : t === "Conversations"
                    ? data.conversations.length
                    : data.jobs.filter((j) =>
                        ["queued", "running"].includes(j.status),
                      ).length}
            </span>
            {tab === t && (
              <motion.span
                layoutId="outreach-active-tab"
                transition={reduced ? { duration: 0 } : spring}
                className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary"
              />
            )}
          </button>
        ))}
      </nav>
      {error && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {notice && (
        <motion.p
          key={notice}
          role="status"
          initial={reduced ? false : { opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          transition={spring}
          className="flex items-center gap-2 text-sm text-success"
        >
          <Check size={16} />
          {notice}
        </motion.p>
      )}
      <div hidden={tab !== "People"}>
        <OutreachPeople
          data={data}
          pending={pending}
          act={act}
          setTab={(next) => {
            if (next === "Drafts") setDraftFilter("all");
            setTab(next);
          }}
          initialFunding={
            searchParams.get("funding") === "personal" ? "personal" : "hosted"
          }
        />
      </div>
      <div hidden={tab !== "Drafts"}>
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <select
              aria-label="Filter drafts"
              className="rounded-lg border bg-background p-2 text-sm"
              value={draftFilter}
              onChange={(e) => setDraftFilter(e.target.value)}
            >
              <option value="all">All drafts</option>
              <option value="review">Needs review</option>
              <option value="approved">Approved</option>
            </select>
            <Button
              variant="outline"
              onClick={() =>
                setDraftIds(new Set(visibleDrafts.map((m) => m.id)))
              }
            >
              Select all {visibleDrafts.length} matching drafts
            </Button>
            <Button variant="ghost" onClick={() => setDraftIds(new Set())}>
              Clear selection
            </Button>
            <span className="text-sm text-muted-foreground">
              {chosen.length} selected
            </span>
          </div>
          {!drafts.length && (
            <p className="py-10 text-muted-foreground">
              Select people to generate drafts. Completed messages appear in
              Conversations and Activity.
            </p>
          )}
          {chosen.length > 0 && (
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-56 flex-1 text-sm">
                Instructions for selected drafts
                <Input
                  className="mt-2"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="Make the opening more direct and keep it under 80 words"
                />
              </label>
              <Button
                variant="outline"
                disabled={pending || chosen.some((m) => dirtyIds.has(m.id))}
                onClick={() =>
                  act(async () => {
                    for (const kind of [
                      "initial",
                      "follow_up",
                      "reply",
                    ] as const) {
                      const recipients = chosen
                        .filter((m) => m.messageKind === kind)
                        .map((m) => m.prospectId);
                      if (recipients.length)
                        await actions.draftOutreachMessages(
                          id,
                          recipients,
                          instructions,
                          kind,
                        );
                    }
                  }, "Selected drafts queued for regeneration.")
                }
              >
                Rewrite selected drafts
              </Button>
            </div>
          )}
          <DraftList
            drafts={visibleDrafts}
            activeId={activeDraft}
            onActive={setActiveDraft}
            selected={draftIds}
            onToggle={toggleDraft}
            edits={edits}
            onEdit={editDraft}
            onSaved={refresh}
            onError={setError}
          />
          {chosen.length > 0 && (
            <ActionBar>
              <div className="w-full space-y-3">
                {chosen.some(
                  (m) =>
                    m.channel === "email" &&
                    m.person.research?.emailStatus !== "verified",
                ) && (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={unverified}
                      onChange={(e) => setUnverified(e.target.checked)}
                    />
                    I reviewed addresses marked unverified.
                  </label>
                )}
                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="outline"
                    disabled={pending || chosen.some((m) => dirtyIds.has(m.id))}
                    onClick={() =>
                      act(
                        () =>
                          actions.approveOutreachDrafts(
                            id,
                            chosen.map((m) => ({
                              id: m.id,
                              revision: m.revision,
                            })),
                            unverified,
                          ),
                        "Current saved revisions approved.",
                      )
                    }
                  >
                    <Check size={16} />
                    Approve {chosen.length}{" "}
                    {chosen.length === 1 ? "draft" : "drafts"}
                  </Button>
                  <Button
                    disabled={
                      pending ||
                      chosen.some(
                        (m) =>
                          dirtyIds.has(m.id) ||
                          m.approvedRevision !== m.revision,
                      )
                    }
                    onClick={() => setSendReview(true)}
                  >
                    <Send size={16} />
                    Review & send
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Edits require a new approval before sending.
                </p>
              </div>
            </ActionBar>
          )}
          <SendReview
            open={sendReview}
            onOpenChange={setSendReview}
            chosen={chosen}
            pending={pending}
            disabled={chosen.some(
              (m) => dirtyIds.has(m.id) || m.approvedRevision !== m.revision,
            )}
            onSend={() =>
              act(async () => {
                await actions.sendOutreachDrafts(
                  id,
                  chosen.map((m) => m.id),
                );
                setSendReview(false);
                setDraftIds(new Set());
                setTab("Activity");
              }, "Messages queued. Browser messages need an active Orbit extension session.")
            }
          />
        </div>
      </div>
      <div hidden={tab !== "Conversations"}>
        <OutreachConversations
          data={data}
          due={due}
          pending={pending}
          act={act}
          setTab={(next) => {
            if (next === "Drafts") setDraftFilter("all");
            setTab(next);
          }}
          activeId={activeConversation}
          onActive={setActiveConversation}
          filter={conversationFilter}
          onFilter={setConversationFilter}
          drafts={drafts}
          edits={edits}
          onEdit={editDraft}
          onSaved={refresh}
          onError={setError}
          onDraft={(id) => {
            setDraftFilter("all");
            setActiveDraft(id);
            setDraftIds(new Set([id]));
          }}
        />
      </div>
      <div hidden={tab !== "Activity"}>
        <OutreachActivity
          data={data}
          messages={messages}
          pending={pending}
          act={act}
          issuesOnly={issuesOnly}
          onIssuesOnly={setIssuesOnly}
        />
      </div>
    </div>
  );
}
