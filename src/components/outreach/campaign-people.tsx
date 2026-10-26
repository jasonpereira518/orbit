"use client";

import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import {
  addProspects,
  attachBrief,
  removeProspect,
  setProspectEmail,
  setProspectLinkedin,
} from "@/actions/outreach-people";
import { requestBrief } from "@/components/find/request-brief";
import { FindCandidates } from "@/components/outreach/find-candidates";
import { WarmPathNote } from "@/components/outreach/warm-path-note";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, focusFirstInvalid, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { IntentLink } from "@/components/ui/intent-link";
import { friendlyError, type ActionResult } from "@/lib/errors";
import { asLinkedInProfile, buildLinkedInSearchUrl, buildLinkedInUrl } from "@/lib/outreach-channels";
import {
  hasBeenContacted,
  hasBeenContactedOnLinkedin,
  hasBeenEmailed,
  isInNetwork,
  prospectPipelineBucket,
  type MessageMetricRow,
} from "@/lib/outreach-metrics";
import { EMAIL_SHAPE, type OutreachChannel, type PipelineFilter, type ProspectEnrichment } from "@/lib/outreach-types";
import { TOAST_COPY } from "@/lib/toast-copy";
import type { WarmPath } from "@/lib/warm-paths";
import type { PersonDossier } from "@/lib/web-research";
import { cn } from "@/lib/utils";

/** A person on a campaign, as the page hands them over: only what this tab shows or decides on. */
export type CampaignPerson = {
  id: string;
  status: string;
  fullName: string;
  title: string | null;
  company: string | null;
  email: string | null;
  linkedinUrl: string | null;
  contactId: string | null;
  enrichment: ProspectEnrichment;
  messages: MessageMetricRow[];
};

const LINKEDIN_HINT = "It should look like linkedin.com/in/jane-doe";

/** Where a person stands, in words, for the channel the campaign uses. */
function readiness(bucket: PipelineFilter, channel: OutreachChannel): { text: string; needsInfo: boolean } {
  switch (bucket) {
    case "needs_info":
      return { text: channel === "linkedin" ? "Needs a LinkedIn link" : "Needs an email", needsInfo: true };
    case "needs_draft":
      return { text: "Ready for a draft", needsInfo: false };
    case "ready":
      return { text: "Draft ready", needsInfo: false };
    case "waiting":
      return { text: "Sent — waiting for a reply", needsInfo: false };
    case "follow_up_due":
      return { text: "Follow-up due", needsInfo: false };
    case "replied":
      return { text: "Replied", needsInfo: false };
    case "failed":
      return { text: "Needs attention", needsInfo: false };
    default:
      return { text: "", needsInfo: false };
  }
}

export function CampaignPeople({
  campaign,
  channel,
  prospects,
  warmPaths,
  knownNames,
  canUseAi,
}: {
  campaign: { id: string; audienceQuery: string };
  channel: OutreachChannel;
  prospects: CampaignPerson[];
  /** Normalised company key -> people the user already knows there. */
  warmPaths: Record<string, WarmPath[]>;
  knownNames: string[];
  canUseAi: boolean;
}) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [notice, setNotice] = useState("");

  return (
    <div className="space-y-5">
      {/* Keyed by the audience, so a different search never shows the last one's people. */}
      <FindCandidates
        key={campaign.audienceQuery}
        campaignId={campaign.id}
        audienceQuery={campaign.audienceQuery}
        knownNames={knownNames}
        canUseAi={canUseAi}
      />
      <AddSomeone campaignId={campaign.id} channel={channel} />

      <section aria-labelledby={headingId} className="space-y-3">
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="text-sm font-medium text-ink outline-none"
        >
          On your list <span className="text-muted-foreground">· {prospects.length}</span>
        </h2>
        <p role="status" className="text-sm text-muted-foreground empty:hidden">
          {notice}
        </p>
        {prospects.length ? (
          <ul className="space-y-3">
            {prospects.map((person) => (
              <PersonRow
                key={person.id}
                person={person}
                channel={channel}
                warmPaths={warmPaths}
                canUseAi={canUseAi}
                onRemoved={() => {
                  // The row is about to go; park focus on the list so it isn’t dropped to the page.
                  setNotice(`Removed ${person.fullName}`);
                  headingRef.current?.focus();
                }}
              />
            ))}
          </ul>
        ) : (
          <p className="rounded-2xl border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground">
            No one on the list yet. Find people who match above, or add someone you already have in mind.
          </p>
        )}
      </section>
    </div>
  );
}

function PersonRow({
  person,
  channel,
  warmPaths,
  canUseAi,
  onRemoved,
}: {
  person: CampaignPerson;
  channel: OutreachChannel;
  warmPaths: Record<string, WarmPath[]>;
  canUseAi: boolean;
  onRemoved: () => void;
}) {
  const hintId = useId();
  const [removing, setRemoving] = useState(false);
  const [researching, setResearching] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [briefNote, setBriefNote] = useState<string | null>(null);

  const bucket = prospectPipelineBucket(person, channel);
  const status = readiness(bucket, channel);
  const contacted = hasBeenContacted(person.messages);
  const { whyMatches, url: source, researchKey } = person.enrichment;
  const where = [person.title, person.company].filter(Boolean).join(" · ");

  async function research() {
    setResearching(true);
    setBriefNote(null);
    setProblem(null);
    try {
      const { key, dossier } = await requestBrief<PersonDossier>({
        kind: "person",
        fullName: person.fullName,
        company: person.company ?? "",
        linkedinUrl: person.linkedinUrl ?? "",
      });
      const res = await attachBrief(person.id, key);
      if (!res.ok) setProblem(res.error);
      else
        setBriefNote(
          dossier.match === "confident" ? "Brief attached" : "Brief attached, but it couldn’t confirm it’s them"
        );
    } catch (err) {
      // The route's own words for a spent daily limit (429) or a missing key (402).
      setProblem(friendlyError(err, "The search didn’t finish — try again in a moment"));
    } finally {
      setResearching(false);
    }
  }

  async function remove() {
    setRemoving(true);
    setProblem(null);
    try {
      const res = await removeProspect(person.id);
      if (res.ok) onRemoved();
      else setProblem(res.error);
    } catch (err) {
      setProblem(friendlyError(err, "Couldn’t remove them — try again?"));
    } finally {
      setRemoving(false);
    }
  }

  return (
    <li className="rounded-2xl border border-border/70 bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{person.fullName}</span>
            {isInNetwork(person) &&
              (person.contactId ? (
                <IntentLink
                  href={`/contacts/${person.contactId}`}
                  className={cn(badgeVariants({ variant: "outline" }), "hover:bg-muted")}
                >
                  Already in your network
                </IntentLink>
              ) : (
                <Badge variant="outline">Already in your network</Badge>
              ))}
            {researchKey && (
              <Badge variant="outline">
                <Check aria-hidden /> Researched
              </Badge>
            )}
          </div>
          {where && <p className="text-sm text-muted-foreground">{where}</p>}
          {whyMatches && (
            <p className="mt-1 text-sm text-ink/80">
              {whyMatches}
              {source && (
                <a
                  href={source}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="ml-1.5 inline-flex align-middle text-muted-foreground hover:text-ink"
                  aria-label={`Where ${person.fullName} was found (opens in a new tab)`}
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                </a>
              )}
            </p>
          )}
          <WarmPathNote company={person.company} warmPaths={warmPaths} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!canUseAi || researching}
            title={canUseAi ? undefined : "Add an AI key to research people"}
            onClick={research}
          >
            {researching && <Loader2 className="animate-spin" aria-hidden />}
            {researching ? "Researching…" : "Research"}
            <span className="sr-only"> {person.fullName}</span>
          </Button>
          {contacted ? (
            <span className="text-xs text-muted-foreground">Contacted</span>
          ) : (
            <Button size="sm" variant="ghost" disabled={removing} onClick={remove}>
              {removing ? "Removing…" : "Remove"}
              <span className="sr-only"> {person.fullName}</span>
            </Button>
          )}
        </div>
      </div>

      <div className="mt-3 border-t border-border/50 pt-3">
        {channel === "linkedin" ? (
          <SavedField
            label={person.linkedinUrl ? "LinkedIn link" : "Add LinkedIn link"}
            name={person.fullName}
            saved={person.linkedinUrl ?? ""}
            save={(value) => setProspectLinkedin(person.id, value)}
            // A pasted link is tidied the way Add someone does (https, no tracking); anything
            // that still isn’t a profile goes to the server as typed, so its refusal is shown.
            prepare={(text) => asLinkedInProfile(text) ?? text}
            locked={hasBeenContactedOnLinkedin(person.messages)}
            lockedNote="Already contacted on LinkedIn, so the link stays"
            type="url"
            placeholder="linkedin.com/in/…"
            maxLength={300}
            hintId={hintId}
            status={status}
            aside={
              <a
                href={
                  person.linkedinUrl
                    ? buildLinkedInUrl(person.linkedinUrl)
                    : buildLinkedInSearchUrl(person.fullName, person.company)
                }
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
              >
                {person.linkedinUrl ? "View profile" : "Find on LinkedIn"}
                <span className="sr-only"> for {person.fullName}</span>
                <ExternalLink className="size-3" aria-hidden />
              </a>
            }
          />
        ) : (
          <SavedField
            label="Email"
            name={person.fullName}
            saved={person.email ?? ""}
            save={(value) => setProspectEmail(person.id, value)}
            locked={hasBeenEmailed(person.messages)}
            lockedNote="Already emailed, so the address stays"
            type="email"
            inputMode="email"
            placeholder="name@company.com"
            maxLength={254}
            hintId={hintId}
            status={status}
          />
        )}
      </div>

      <div aria-live="polite" className="empty:hidden">
        {briefNote && <p className="mt-2 text-xs text-muted-foreground">{briefNote}</p>}
        {problem && <p className="mt-2 text-xs text-destructive">{problem}</p>}
      </div>
    </li>
  );
}

function Readiness({ id, status }: { id: string; status: { text: string; needsInfo: boolean } }) {
  return (
    <p
      id={id}
      aria-live="polite"
      className={cn("text-xs", status.needsInfo ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}
    >
      {status.text}
    </p>
  );
}

/**
 * One detail a message needs (an email address, a LinkedIn link), saved on blur or Enter. The
 * server’s refusal (a bad value, or one already messaged) shows under the box. Read-only once
 * a message to them has gone out on this channel.
 */
function SavedField({
  label,
  name,
  saved,
  save: saveValue,
  prepare = (text) => text,
  locked,
  lockedNote,
  type,
  inputMode,
  placeholder,
  maxLength,
  hintId,
  status,
  aside,
}: {
  label: string;
  /** Who it is for, said to screen readers after the label. */
  name: string;
  /** What is stored now. */
  saved: string;
  save: (value: string | null) => Promise<ActionResult<void>>;
  /** What typed text becomes before it is sent. */
  prepare?: (text: string) => string;
  locked: boolean;
  lockedNote: string;
  type: "email" | "url";
  inputMode?: "email";
  placeholder: string;
  maxLength: number;
  hintId: string;
  status: { text: string; needsInfo: boolean };
  aside?: ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const [value, setValue] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // What was last sent, so Enter followed by blur saves once, and an unchanged box saves nothing.
  const [sent, setSent] = useState(saved);
  // When what is stored moves (this save landed, tidied, or it changed elsewhere) the box shows
  // it. The box is not remounted for that: a keyboard user pressing Enter keeps their place.
  const [seen, setSeen] = useState(saved);
  if (saved !== seen) {
    setSeen(saved);
    setValue(saved);
    setSent(saved);
  }

  async function save() {
    const next = prepare(value.trim());
    if (locked || next === sent) return;
    setSent(next);
    setSaving(true);
    setError(null);
    try {
      const res = await saveValue(next || null);
      if (!res.ok) setError(res.error);
    } catch (err) {
      setSent(saved);
      setError(friendlyError(err, TOAST_COPY.saveFailed));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      // The server says what is wrong, in the same place whether it was saved by Enter or by
      // leaving the box; the browser’s own bubble would only cover Enter.
      noValidate
      className="space-y-1"
    >
      <label htmlFor={id} className="block text-xs font-medium text-muted-foreground">
        {label}
        <span className="sr-only"> for {name}</span>
      </label>
      <Input
        id={id}
        type={type}
        inputMode={inputMode}
        autoComplete="off"
        maxLength={maxLength}
        value={value}
        readOnly={locked}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, error ? errorId : null].filter(Boolean).join(" ")}
        className="max-w-sm"
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Readiness id={hintId} status={saving ? { text: "Saving…", needsInfo: false } : status} />
        {locked && <span className="text-xs text-muted-foreground">{lockedNote}</span>}
        {aside}
      </div>
      <FormError id={errorId} className="text-xs font-normal">
        {error}
      </FormError>
    </form>
  );
}

/**
 * Add one person by hand: their name, where to pin them down (a company, or their LinkedIn
 * profile link), and an email if you have one. This is also where a LinkedIn link is added.
 */
function AddSomeone({ campaignId, channel }: { campaignId: string; channel: OutreachChannel }) {
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [where, setWhere] = useState("");
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const target = where.trim();
    const linkedin = asLinkedInProfile(target);
    if (/linkedin\.com/i.test(target) && !linkedin) {
      setError(`That isn’t a LinkedIn profile link. ${LINKEDIN_HINT}`);
      return;
    }
    // The server drops an address it doesn’t like without a word, so it is checked here, where
    // it can be said.
    if (email.trim() && !EMAIL_SHAPE.test(email.trim().toLowerCase())) {
      setEmailError("That address doesn’t look right");
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    setBusy(true);
    setError(null);
    setEmailError(null);
    setDone("");
    try {
      const res = await addProspects(campaignId, [
        {
          fullName: name.trim(),
          ...(linkedin ? { linkedinUrl: linkedin } : { company: target }),
          email: email.trim() || null,
          origin: "manual",
        },
      ]);
      if (!res.ok) {
        setError(res.error);
      } else if (res.value.added) {
        setDone(`Added ${name.trim()}`);
        setName("");
        setWhere("");
        setEmail("");
        nameRef.current?.focus();
      } else if (res.value.alreadyThere) {
        // Includes someone put back from removed: they are on the list again.
        setDone(`${name.trim()} is on the list`);
      } else {
        setError("Add their name and a company or LinkedIn link");
      }
    } catch (err) {
      setError(friendlyError(err, "Couldn’t add them — try again?"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="rounded-2xl border border-border/70 bg-card p-4">
      <summary className="cursor-pointer text-sm font-medium text-ink">Add someone</summary>
      <form ref={formRef} onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Name" required>
          <Input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
            maxLength={100}
            autoComplete="off"
            placeholder="Jane Doe"
          />
        </Field>
        <Field
          label="Company or LinkedIn link"
          required
          description={
            channel === "linkedin"
              ? "A LinkedIn campaign needs their profile link, so add it here."
              : "Their company, or their LinkedIn profile link."
          }
        >
          <Input
            value={where}
            onChange={(e) => {
              setWhere(e.target.value);
              setError(null);
            }}
            required
            maxLength={300}
            autoComplete="off"
            placeholder="Stripe, or linkedin.com/in/jane-doe"
          />
        </Field>
        <Field label="Email" description="If you have it. You can add it later." error={emailError}>
          {/* Text, not type="email": the browser’s own check would answer before this form does. */}
          <Input
            type="text"
            inputMode="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setEmailError(null);
            }}
            maxLength={254}
            autoComplete="off"
            placeholder="jane@company.com"
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Adding…" : "Add to list"}
          </Button>
          <p role="status" className="text-sm text-muted-foreground empty:hidden">
            {done}
          </p>
        </div>
        <FormError className="sm:col-span-2">{error}</FormError>
      </form>
    </details>
  );
}
