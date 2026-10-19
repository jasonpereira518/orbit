"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, Loader2, Send, Trash2 } from "lucide-react";
import {
  discardRecruiterDrafts,
  generateRecruiterDrafts,
  sendRecruiterDrafts,
  updateRecruiterDraft,
} from "@/actions/recruiter-messages";
import type { RecruiterDraft } from "@/lib/recruiter-message-types";
import { startGmailOAuth, type GmailSendIdentity } from "@/actions/gmail";
import { IntegrationLogo } from "@/components/integrations/integration-logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

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

        <Card>
          <CardHeader>
            <CardTitle as="h2">1. What do you want to say?</CardTitle>
            <CardDescription>
              Orbit writes each email from your history with that recruiter. You review
              every one before anything sends.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FormField label="Message intent" id="compose-intent" className="max-w-sm">
              <Select value={intent} onValueChange={(v) => setIntent(String(v ?? intent))} items={intents}>
                <SelectTrigger id="compose-intent" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {intents.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle as="h2">2. Who should get it?</CardTitle>
              <CardDescription className="mt-1">
                {sendable.length} recruiter{sendable.length === 1 ? "" : "s"} with an
                email address.
                {missingEmail > 0
                  ? ` ${missingEmail} hidden — no address on file.`
                  : ""}
              </CardDescription>
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
              {picked.size === sendable.length ? "Clear selection" : "Select all"}
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {sendable.length === 0 ? (
              <EmptyState
                variant="plain"
                size="sm"
                title="No recruiters with an email address"
                description="Scan your inbox or add an address on a recruiter’s page."
              />
            ) : (
              <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
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

            <div className="flex justify-end">
              <Button
                disabled={pending || picked.size === 0}
                onClick={() =>
                  start(async () => {
                    try {
                      const res = await generateRecruiterDrafts(
                        Array.from(picked),
                        intent
                      );
                      if (!res.ok) {
                        toast.error(res.error);
                        return;
                      }
                      const created = res.value;
                      setDrafts(created);
                      setSelectedDrafts(new Set(created.map((d) => d.id)));
                      setPicked(new Set());
                      toast.success(
                        `Drafted ${created.length} email${created.length === 1 ? "" : "s"}`
                      );
                    } catch (err) {
                      toast.error(
                        friendlyError(err, "Couldn’t write those drafts — try again?")
                      );
                    }
                  })
                }
              >
                {pending ? (
                  <>
                    <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
                    Drafting…
                  </>
                ) : (
                  `Draft ${picked.size || ""} email${picked.size === 1 ? "" : "s"}`.trim()
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SendIdentityCard identity={identity} />
      {identity.connected && !canSend && <ReconnectBanner />}

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle as="h2">
              {drafts.length} draft{drafts.length === 1 ? "" : "s"} ready
            </CardTitle>
            <CardDescription className="mt-1">
              Read each one before sending. {quota.remaining} of {quota.limit} sends left
              today.
            </CardDescription>
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
              <Trash2 className="size-4" />
              Discard all
            </Button>
            <Button
              disabled={pending || selectedDrafts.size === 0 || !canSend}
              onClick={() =>
                start(async () => {
                  try {
                    const res = await sendRecruiterDrafts(
                      Array.from(selectedDrafts)
                    );
                    if (!res.ok) {
                      toast.error(res.error);
                      return;
                    }
                    const result = res.value;
                    if (result.sent > 0) {
                      toast.success(
                        `Sent ${result.sent} email${result.sent === 1 ? "" : "s"}`
                      );
                    }
                    // Each failure is already a whole sentence that names the person.
                    for (const f of result.failed) {
                      toast.error(f.error);
                    }
                    setDrafts((prev) =>
                      prev.filter((d) => !selectedDrafts.has(d.id))
                    );
                    setSelectedDrafts(new Set());
                    router.refresh();
                  } catch (err) {
                    toast.error(
                      friendlyError(err, TOAST_COPY.sendFailed)
                    );
                  }
                })
              }
            >
              {pending ? (
                <>
                  <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
                  Sending…
                </>
              ) : (
                <>
                  <Send className="size-4" />
                  Send {selectedDrafts.size} selected
                </>
              )}
            </Button>
          </div>
        </CardHeader>
      </Card>

      <ul className="space-y-4">
        {drafts.map((d) => (
          <li key={d.id} className="space-y-3 rounded-xl border border-border-subtle bg-card p-5">
            <div className="flex items-start gap-3">
              <Checkbox
                checked={selectedDrafts.has(d.id)}
                onCheckedChange={() =>
                  setSelectedDrafts((p) => toggle(p, d.id))
                }
                className="mt-1"
                aria-label={`Send to ${d.recruiterName}`}
              />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-ink">{d.recruiterName}</p>
                <p className="text-sm text-muted-foreground">
                  {d.recruiterFirm ? `${d.recruiterFirm} · ` : ""}
                  {d.recruiterEmail}
                </p>
              </div>
            </div>

            <FormField label="Subject" id={`subject-${d.id}`}>
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
            </FormField>
            <FormField label="Message" id={`body-${d.id}`}>
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
            </FormField>
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
      <div className="flex items-start gap-3 rounded-xl border border-dashed border-border-subtle bg-card px-5 py-4 text-sm text-muted-foreground">
        <IntegrationLogo provider="gmail" size="sm" />
        <p>
          Gmail isn’t connected, so there’s no address to send from yet. You can still
          draft — connect Gmail from the Recruiters page before sending.
        </p>
      </div>
    );
  }

  const mismatch = !identity.matchesLogin;

  return (
    <Card variant={mismatch ? "inset" : "default"}>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <IntegrationLogo provider="gmail" size="md" className="mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Sending as
            </p>
            <p className="mt-1 break-words font-medium text-foreground">
              {identity.displayName
                ? `${identity.displayName} <${identity.sendingAs}>`
                : identity.sendingAs}
            </p>
            {mismatch ? (
              <p className="mt-2 flex max-w-prose items-start gap-2 text-sm text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  This isn’t the address you sign into Orbit with
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
                  const { url } = await startGmailOAuth({ purpose: "send", returnTo: "/recruiters/compose" });
                  window.location.href = url;
                } catch (err) {
                  toast.error(friendlyError(err, TOAST_COPY.connectFailed));
                }
              })
            }
          >
            {pending ? "Connecting…" : "Use a different account"}
          </Button>
        )}
      </CardHeader>
    </Card>
  );
}

/** Shown when the Gmail grant does not include gmail.send. */
function ReconnectBanner() {
  const [pending, start] = useTransition();
  return (
    <Card variant="inset">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div>
            <p className="font-medium text-foreground">Allow Gmail to send</p>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              You can draft now. Sending from your own address needs Google’s permission to
              send as you, which Orbit asks for only when you want it.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              try {
                const { url } = await startGmailOAuth({ purpose: "send", returnTo: "/recruiters/compose" });
                window.location.href = url;
              } catch (err) {
                toast.error(friendlyError(err, TOAST_COPY.connectFailed));
              }
            })
          }
        >
          {pending ? "Connecting…" : "Reconnect"}
        </Button>
      </CardHeader>
    </Card>
  );
}
