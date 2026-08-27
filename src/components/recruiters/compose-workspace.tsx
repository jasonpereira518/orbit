"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, Loader2, Mail, Send, Trash2 } from "lucide-react";
import {
  discardRecruiterDrafts,
  generateRecruiterDrafts,
  sendRecruiterDrafts,
  updateRecruiterDraft,
} from "@/actions/recruiter-messages";
import type { RecruiterDraft } from "@/lib/recruiter-message-types";
import { startGmailOAuth, type GmailSendIdentity } from "@/actions/gmail";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";

export type ComposeRecruiter = {
  id: string;
  fullName: string;
  firm: string | null;
  email: string | null;
  hasHistory: boolean;
};

export function ComposeWorkspace({
  recruiters,
  initialDrafts,
  intents,
  quota,
  canSend,
  identity,
}: {
  recruiters: ComposeRecruiter[];
  initialDrafts: RecruiterDraft[];
  intents: Array<{ value: string; label: string }>;
  quota: { used: number; limit: number; remaining: number };
  canSend: boolean;
  identity: GmailSendIdentity;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [drafts, setDrafts] = useState<RecruiterDraft[]>(initialDrafts);
  const [intent, setIntent] = useState(intents[0]?.value ?? "set_up_chat");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [selectedDrafts, setSelectedDrafts] = useState<Set<string>>(
    new Set(initialDrafts.map((d) => d.id))
  );

  // Drafting leans on the private Gmail summary, and sending needs somewhere to send to.
  const sendable = useMemo(
    () => recruiters.filter((r) => r.email),
    [recruiters]
  );
  const missingEmail = recruiters.length - sendable.length;

  function toggle(set: Set<string>, id: string) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  function patchDraft(id: string, patch: Partial<RecruiterDraft>) {
    setDrafts((prev) =>
      prev.map((d) => (d.id === id ? { ...d, ...patch } : d))
    );
  }

  if (drafts.length === 0) {
    return (
      <div className="space-y-5">
        <SendIdentityCard identity={identity} />
        {identity.connected && !canSend && <ReconnectBanner />}

        <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
          <div>
            <h2 className="font-medium text-ink">1. What do you want to say?</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Orbit writes each email from your history with that recruiter. You review
              every one before anything sends.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="compose-intent">Message intent</Label>
            <select
              id="compose-intent"
              className="flex h-9 w-full max-w-sm rounded-lg border border-input bg-transparent px-3 text-sm"
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
            >
              {intents.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-medium text-ink">2. Who should get it?</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {sendable.length} recruiter{sendable.length === 1 ? "" : "s"} with an
                email address.
                {missingEmail > 0
                  ? ` ${missingEmail} hidden — no address on file.`
                  : ""}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={pending || sendable.length === 0}
              onClick={() =>
                setPicked(
                  picked.size === sendable.length
                    ? new Set()
                    : new Set(sendable.map((r) => r.id))
                )
              }
            >
              {picked.size === sendable.length ? "Clear all" : "Select all"}
            </Button>
          </div>

          {sendable.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              None of your recruiters have an email address yet. Scan Gmail or add one
              on a recruiter&apos;s page.
            </p>
          ) : (
            <ul className="divide-y divide-border/60 rounded-xl border border-border/60">
              {sendable.map((r) => (
                <li key={r.id}>
                  <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5">
                    <Checkbox
                      checked={picked.has(r.id)}
                      onCheckedChange={() => setPicked((p) => toggle(p, r.id))}
                    />
                    <span className="min-w-0 flex-1 text-sm">
                      <span className="block font-medium">{r.fullName}</span>
                      <span className="block text-muted-foreground">
                        {r.firm || "Unknown firm"} · {r.email}
                      </span>
                      {!r.hasHistory && (
                        <span className="mt-0.5 block text-xs text-muted-foreground/80">
                          No history yet — the draft will be more generic.
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          <Button
            disabled={pending || picked.size === 0}
            className="bg-primary text-primary-foreground"
            onClick={() =>
              start(async () => {
                try {
                  const created = await generateRecruiterDrafts(
                    Array.from(picked),
                    intent
                  );
                  setDrafts(created);
                  setSelectedDrafts(new Set(created.map((d) => d.id)));
                  setPicked(new Set());
                  toast.success(
                    `Drafted ${created.length} email${created.length === 1 ? "" : "s"}`
                  );
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "Could not draft"
                  );
                }
              })
            }
          >
            {pending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Drafting…
              </>
            ) : (
              `Draft ${picked.size || ""} email${picked.size === 1 ? "" : "s"}`.trim()
            )}
          </Button>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SendIdentityCard identity={identity} />
      {identity.connected && !canSend && <ReconnectBanner />}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card p-5">
        <div>
          <h2 className="font-medium text-ink">
            {drafts.length} draft{drafts.length === 1 ? "" : "s"} ready
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Read each one before sending. {quota.remaining} of {quota.limit} sends left
            today.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                await discardRecruiterDrafts(drafts.map((d) => d.id));
                setDrafts([]);
                setSelectedDrafts(new Set());
                toast.success("Drafts discarded");
                router.refresh();
              })
            }
          >
            <Trash2 className="mr-1.5 h-4 w-4" />
            Discard all
          </Button>
          <Button
            className="bg-primary text-primary-foreground"
            disabled={pending || selectedDrafts.size === 0 || !canSend}
            onClick={() =>
              start(async () => {
                try {
                  const result = await sendRecruiterDrafts(
                    Array.from(selectedDrafts)
                  );
                  if (result.sent > 0) {
                    toast.success(
                      `Sent ${result.sent} email${result.sent === 1 ? "" : "s"}`
                    );
                  }
                  for (const f of result.failed) {
                    toast.error(`${f.recruiterName}: ${f.error}`);
                  }
                  setDrafts((prev) =>
                    prev.filter((d) => !selectedDrafts.has(d.id))
                  );
                  setSelectedDrafts(new Set());
                  router.refresh();
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "Send failed"
                  );
                }
              })
            }
          >
            {pending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <Send className="mr-1.5 h-4 w-4" />
                Send {selectedDrafts.size} selected
              </>
            )}
          </Button>
        </div>
      </div>

      <ul className="space-y-4">
        {drafts.map((d) => (
          <li
            key={d.id}
            className="space-y-3 rounded-2xl border border-border/70 bg-card p-5"
          >
            <div className="flex items-start gap-3">
              <Checkbox
                checked={selectedDrafts.has(d.id)}
                onCheckedChange={() =>
                  setSelectedDrafts((p) => toggle(p, d.id))
                }
                className="mt-1"
              />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-ink">{d.recruiterName}</p>
                <p className="text-sm text-muted-foreground">
                  {d.recruiterFirm ? `${d.recruiterFirm} · ` : ""}
                  {d.recruiterEmail}
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`subject-${d.id}`}>Subject</Label>
              <Input
                id={`subject-${d.id}`}
                value={d.subject}
                onChange={(e) => patchDraft(d.id, { subject: e.target.value })}
                onBlur={() =>
                  start(async () => {
                    await updateRecruiterDraft(d.id, { subject: d.subject });
                  })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`body-${d.id}`}>Message</Label>
              <Textarea
                id={`body-${d.id}`}
                rows={8}
                value={d.body}
                onChange={(e) => patchDraft(d.id, { body: e.target.value })}
                onBlur={() =>
                  start(async () => {
                    await updateRecruiterDraft(d.id, { body: d.body });
                  })
                }
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * States the address recruiters will see, before anything is sent.
 *
 * Gmail sends as the account that authorized it, so this is reported rather than
 * chosen. When it differs from the Orbit login the mismatch is called out — that is
 * allowed (work SSO login, personal job-search Gmail) but must never be a surprise.
 */
function SendIdentityCard({ identity }: { identity: GmailSendIdentity }) {
  const [pending, start] = useTransition();

  if (!identity.connected || !identity.sendingAs) {
    return (
      <div className="rounded-2xl border border-dashed border-border/70 bg-card/50 px-5 py-4 text-sm text-muted-foreground">
        Gmail isn&apos;t connected, so there&apos;s no address to send from yet. You can
        still draft — connect Gmail from the Recruiters page before sending.
      </div>
    );
  }

  const mismatch = !identity.matchesLogin;

  return (
    <section
      className={
        mismatch
          ? "rounded-2xl border border-border/70 bg-muted/40 p-5"
          : "rounded-2xl border border-border/70 bg-card p-5"
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <Mail className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Sending as
            </p>
            <p className="mt-1 break-words font-medium text-foreground">
              {identity.displayName
                ? `${identity.displayName} <${identity.sendingAs}>`
                : identity.sendingAs}
            </p>
            {mismatch ? (
              <p className="mt-2 flex max-w-prose items-start gap-2 text-sm text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  This isn&apos;t the address you sign into Orbit with
                  {identity.loginEmail ? ` (${identity.loginEmail})` : ""}. Recruiters
                  will see the Gmail address above, and replies go to that inbox.
                </span>
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                Replies land in this inbox, and each email appears in its Sent folder.
              </p>
            )}
          </div>
        </div>
        {mismatch && (
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() =>
              start(async () => {
                try {
                  const { url } = await startGmailOAuth("/recruiters/compose");
                  window.location.href = url;
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "OAuth failed");
                }
              })
            }
          >
            Use a different account
          </Button>
        )}
      </div>
    </section>
  );
}

/** Shown when the Gmail connection predates the send scope. */
function ReconnectBanner() {
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-border/70 bg-muted/40 p-5">
      <div className="flex gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div>
          <p className="font-medium text-foreground">
            Reconnect Gmail to send
          </p>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Your Gmail connection was made before Orbit could send on your behalf. You
            can draft now, but sending needs permission you haven&apos;t granted yet.
          </p>
        </div>
      </div>
      <Button
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            try {
              const { url } = await startGmailOAuth("/recruiters/compose");
              window.location.href = url;
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "OAuth failed");
            }
          })
        }
      >
        Reconnect
      </Button>
    </div>
  );
}
