"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Briefcase, AtSign, Sparkles, HeartHandshake, NotebookPen, type LucideIcon } from "lucide-react";
import { useGuardedTransition } from "@/lib/single-flight";
import { toast } from "@/lib/toast";
import {
  createContact,
  getContactFieldSuggestions,
  lookupLinkedInProfile,
  updateContact,
  type ContactFieldSuggestions,
  type ContactInput,
} from "@/actions/contacts";
import { queueContactWorkHistory } from "@/actions/contact-profile";
import { MET_CONTEXTS, MET_CONTEXT_LABELS, type MetContext } from "@/lib/met-context";
import { SuggestInput } from "@/components/contacts/suggest-input";
import { OrgField } from "@/components/contacts/org-combobox";
import { ChoicePills, StrengthDots, TagInput } from "@/components/contacts/contact-form-controls";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

const EMPTY_SUGGESTIONS: ContactFieldSuggestions = {
  locations: [],
  schools: [],
  locationBySchool: {},
  schoolByLocation: {},
};

function looksLikeLinkedInProfile(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(
      trimmed.startsWith("http") ? trimmed : `https://${trimmed}`
    );
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    return host === "linkedin.com" && /\/in\//i.test(parsed.pathname);
  } catch {
    return /linkedin\.com\/in\//i.test(trimmed);
  }
}

export function ContactForm({
  initial,
  contactId,
  className,
  onSuccess,
  redirectOnSuccess = true,
  compact = false,
  renderHeader,
  pinnedActions = false,
}: {
  initial?: Partial<ContactInput> & { tags?: string[] };
  contactId?: string;
  className?: string;
  onSuccess?: (contact: { id: string }) => void;
  /** Set to false when embedding the form somewhere that manages its own navigation (e.g. the setup wizard). */
  redirectOnSuccess?: boolean;
  /**
   * Just who they are and how you met, in three rows: onboarding's "add someone by hand"
   * has to fit one screen. Everything else is on the profile afterwards.
   */
  compact?: boolean;
  /** Drawn first inside the form, from the live values (the edit sheet's brand header). */
  renderHeader?: (live: { fullName: string; title: string; company: string }) => ReactNode;
  /** Pin the save row to the bottom of the scrolling container (the edit sheet). */
  pinnedActions?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useGuardedTransition();
  const [lookingUp, setLookingUp] = useState(false);
  // A save that failed on the server. The toast can time out or be missed; this stays by the
  // button until the next attempt.
  const [formError, setFormError] = useState<string | null>(null);
  const lastLookupUrl = useRef<string>("");
  // The LinkedIn URL the contact had when the form opened, so a save only searches for work
  // history when the profile is new or changed — not on every edit of an unrelated field.
  const initialLinkedInUrl = useRef((initial?.linkedinUrl || "").trim());
  const [suggestions, setSuggestions] =
    useState<ContactFieldSuggestions>(EMPTY_SUGGESTIONS);
  const [form, setForm] = useState({
    fullName: initial?.fullName || "",
    preferredName: initial?.preferredName || "",
    title: initial?.title || "",
    company: initial?.company || "",
    location: initial?.location || "",
    school: initial?.school || "",
    metContext: (initial?.metContext as MetContext | "") || "",
    dateMet: initial?.dateMet
      ? String(initial.dateMet).slice(0, 10)
      : "",
    howMet: initial?.howMet || "",
    email: initial?.email || "",
    phone: initial?.phone || "",
    linkedinUrl: initial?.linkedinUrl || "",
    website: initial?.website || "",
    notes: initial?.notes || "",
    industry: initial?.industry || "",
    sharedInterests: (initial?.sharedInterests || []).join("\n"),
    relationshipScore: initial?.relationshipScore ?? 2,
    priorityLevel: initial?.priorityLevel ?? 0,
    tagNames: initial?.tagNames || initial?.tags || [],
  });

  /**
   * Whether the user moved the Strength field in *this* session of the form.
   *
   * The field renders at `initial?.relationshipScore ?? 2` whether or not
   * anybody has ever rated this person, so its mere value asserts nothing.
   * Submitting it unconditionally meant creating a contact here — including
   * through the wizard's "Add someone manually" path, which renders this form
   * directly — wrote `stated_closeness = 2` with no input from the user, and
   * editing an imported contact's phone number marked them rated-2 (via the
   * `relationshipScore` mirror in `updateContactForUser`), dropping them out of
   * the compressed prior and making them permanently triage-ineligible.
   *
   * So the rating travels only when the user actually produced one. Leaving it
   * out of the payload is not the same as sending the current value: the update
   * path skips `undefined` fields, and the create path falls back to the
   * legacy default for `relationshipScore` while leaving `stated_closeness`
   * null — which is exactly "nobody has rated this person".
   */
  const [strengthRated, setStrengthRated] = useState(
    initial?.statedCloseness != null
  );

  useEffect(() => {
    let cancelled = false;
    getContactFieldSuggestions()
      .then((data) => {
        if (!cancelled) setSuggestions(data);
      })
      .catch(() => {
        /* suggestions are optional */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function selectLocation(value: string) {
    setForm((f) => {
      const next = { ...f, location: value };
      if (!f.school.trim()) {
        const paired = suggestions.schoolByLocation[value.toLowerCase()];
        if (paired) next.school = paired;
      }
      return next;
    });
  }

  function selectSchool(value: string) {
    setForm((f) => {
      const next = { ...f, school: value };
      if (!f.location.trim()) {
        const paired = suggestions.locationBySchool[value.toLowerCase()];
        if (paired) next.location = paired;
      }
      return next;
    });
  }

  /**
   * A saved LinkedIn URL is a LinkedIn pull: queue a web search for their work history.
   * Returns at once; the history lands on the profile when the search finishes.
   * Best-effort — the contact itself is already saved.
   */
  async function queueWorkHistory(savedId: string, linkedinUrl: string | undefined) {
    const url = linkedinUrl?.trim();
    if (!url || url === initialLinkedInUrl.current) return;
    initialLinkedInUrl.current = url;
    await queueContactWorkHistory(savedId).catch(() => null);
  }

  async function autofillFromLinkedIn(url: string) {
    const trimmed = url.trim();
    if (!looksLikeLinkedInProfile(trimmed)) return;
    if (trimmed === lastLookupUrl.current || lookingUp) return;

    lastLookupUrl.current = trimmed;
    setLookingUp(true);
    try {
      const profile = await lookupLinkedInProfile({
        linkedinUrl: trimmed,
        fullName: form.fullName,
        email: form.email,
      });
      if (!profile) {
        toast.message("Couldn’t find a matching LinkedIn profile");
        return;
      }

      setForm((f) => {
        const next = { ...f };
        // Role is the primary autofill; always take LinkedIn title when present.
        if (profile.title) next.title = profile.title;
        if (profile.company && !f.company.trim()) next.company = profile.company;
        if (profile.location && !f.location.trim())
          next.location = profile.location;
        if (profile.school && !f.school.trim()) next.school = profile.school;
        if (profile.email && !f.email.trim()) next.email = profile.email;
        if (profile.linkedinUrl) next.linkedinUrl = profile.linkedinUrl;
        return next;
      });

      if (profile.title) {
        toast.success(`Role filled: ${profile.title}`);
      } else {
        toast.message("LinkedIn profile found, but no role listed");
      }
    } catch (err) {
      lastLookupUrl.current = "";
      toast.error(
        friendlyError(err, "Couldn’t look that up on LinkedIn — try again?")
      );
    } finally {
      setLookingUp(false);
    }
  }

  return (
    <form
      className={cn(
        "space-y-4 rounded-2xl border border-border/70 bg-card p-6",
        className
      )}
      onKeyDown={(e) => {
        // ⌘↵ / Ctrl+↵ saves from any field. Blurring first lets a half-typed tag land as a
        // chip; the submit waits a tick so it reads the state that blur just set.
        if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
        e.preventDefault();
        const formEl = e.currentTarget;
        (document.activeElement as HTMLElement | null)?.blur();
        setTimeout(() => formEl.requestSubmit(), 0);
      }}
      onSubmit={(e) => {
        e.preventDefault();
        setFormError(null);
        start(async () => {
          try {
            const payload: ContactInput = {
              fullName: form.fullName.trim(),
              preferredName: form.preferredName.trim(),
              title: form.title.trim(),
              company: form.company.trim(),
              location: form.location.trim(),
              school: form.school.trim(),
              metContext: form.metContext || undefined,
              dateMet: form.dateMet || null,
              howMet: form.howMet.trim(),
              email: form.email.trim(),
              phone: form.phone.trim(),
              linkedinUrl: form.linkedinUrl.trim(),
              website: form.website.trim(),
              notes: form.notes.trim(),
              industry: form.industry.trim(),
              sharedInterests: form.sharedInterests
                .split(/[\n,]/)
                .map((t) => t.trim())
                .filter(Boolean),
              // Only when the user actually produced a rating — see
              // `strengthRated` above and ContactInput.statedCloseness in
              // contact-writes.ts.
              ...(strengthRated
                ? {
                    relationshipScore: Number(form.relationshipScore),
                    statedCloseness: Number(form.relationshipScore),
                  }
                : {}),
              priorityLevel: Number(form.priorityLevel),
              tagNames: form.tagNames,
            };
            if (contactId) {
              await updateContact(contactId, payload);
              await queueWorkHistory(contactId, payload.linkedinUrl);
              toast.success("Contact updated");
              onSuccess?.({ id: contactId });
              if (redirectOnSuccess) router.push(`/contacts/${contactId}`);
            } else {
              const c = await createContact(payload, { typedName: true });
              await queueWorkHistory(c.id, payload.linkedinUrl);
              toast.success("Added to your orbit");
              onSuccess?.({ id: c.id });
              if (redirectOnSuccess) router.push(`/contacts/${c.id}`);
            }
            // An update revalidates `/contacts/{id}` (the profile this form edits on) and a
            // redirect fetches the new page, so either way the fresh render has arrived. Only a
            // create that stays put (onboarding) has nothing re-rendered for it (SRV-1).
            if (!contactId && !redirectOnSuccess) router.refresh();
          } catch (err) {
            const message = friendlyError(err, TOAST_COPY.saveFailed);
            toast.error(message);
            setFormError(message);
          }
        });
      }}
    >
      {compact ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" required>
              <Input
                autoComplete="off"
                required
                value={form.fullName}
                onChange={(e) => set("fullName", e.target.value)}
                placeholder="Full name"
              />
            </Field>
            <Field label="LinkedIn URL" description={lookingUp ? "Looking up profile…" : "Paste a profile URL to autofill role"}>
              <Input
                autoComplete="off"
                type="url"
                value={form.linkedinUrl}
                onChange={(e) => {
                  lastLookupUrl.current = "";
                  set("linkedinUrl", e.target.value);
                }}
                onBlur={(e) => {
                  void autofillFromLinkedIn(e.target.value);
                }}
                placeholder="https://linkedin.com/in/..."
                disabled={lookingUp}
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Company">
              <Input
                autoComplete="off"
                value={form.company}
                onChange={(e) => set("company", e.target.value)}
                placeholder="Company"
              />
            </Field>
            <Field label="Role">
              <Input
                autoComplete="off"
                value={form.title}
                onChange={(e) => set("title", e.target.value)}
                placeholder="Role"
              />
            </Field>
          </div>
          <Field label="How you met">
            <Input
              autoComplete="off"
              value={form.howMet}
              onChange={(e) => set("howMet", e.target.value)}
              placeholder="Google NYC event, introduced by Alex…"
            />
          </Field>
        </>
      ) : (
        <>
          {renderHeader?.({ fullName: form.fullName, title: form.title, company: form.company })}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Full name" required>
              <Input
                autoComplete="off"
                required
                value={form.fullName}
                onChange={(e) => set("fullName", e.target.value)}
                placeholder="Full name"
              />
            </Field>
            <Field label="Preferred name">
              <Input
                autoComplete="off"
                value={form.preferredName}
                onChange={(e) => set("preferredName", e.target.value)}
                placeholder="What they go by"
              />
            </Field>
          </div>

          <Section tone="work" icon={Briefcase} title="Work and school">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Company">
                <OrgField
                  kind="company"
                  value={form.company}
                  onChange={(v) => set("company", v)}
                  placeholder="Search companies"
                />
              </Field>
              <Field label="Role" description={lookingUp ? "Looking up LinkedIn…" : undefined}>
                <Input
                  autoComplete="off"
                  value={form.title}
                  onChange={(e) => set("title", e.target.value)}
                  placeholder="Role"
                />
              </Field>
              <Field label="School">
                <OrgField
                  kind="school"
                  value={form.school}
                  onChange={(v) => set("school", v)}
                  onPick={(org) => selectSchool(org.name)}
                  localNames={suggestions.schools}
                  placeholder="Search schools"
                />
              </Field>
              <Field label="Location">
                <SuggestInput
                  value={form.location}
                  onChange={(v) => set("location", v)}
                  onSelect={selectLocation}
                  suggestions={suggestions.locations}
                  placeholder="New York, NY"
                />
              </Field>
            </div>
          </Section>

          <Section tone="reach" icon={AtSign} title="Reach">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Email">
                <Input
                  autoComplete="off"
                  type="email"
                  value={form.email}
                  onChange={(e) => set("email", e.target.value)}
                  placeholder="name@company.com"
                />
              </Field>
              <Field label="Phone">
                <Input
                  autoComplete="off"
                  type="tel"
                  value={form.phone}
                  onChange={(e) => set("phone", e.target.value)}
                  placeholder="+1 555 123 4567"
                />
              </Field>
              <Field label="LinkedIn" description="Paste a profile to fill their role">
                <Input
                  autoComplete="off"
                  type="url"
                  value={form.linkedinUrl}
                  onChange={(e) => {
                    lastLookupUrl.current = "";
                    set("linkedinUrl", e.target.value);
                  }}
                  onBlur={(e) => {
                    void autofillFromLinkedIn(e.target.value);
                  }}
                  placeholder="linkedin.com/in/…"
                  disabled={lookingUp}
                />
              </Field>
              <Field label="Website">
                <Input
                  autoComplete="off"
                  type="url"
                  value={form.website}
                  onChange={(e) => set("website", e.target.value)}
                  placeholder="https://…"
                />
              </Field>
            </div>
          </Section>

          <Section tone="met" icon={Sparkles} title="How you met">
            <ChoicePills
              label="Where"
              options={MET_CONTEXTS.map((value) => ({ value, label: MET_CONTEXT_LABELS[value] }))}
              value={form.metContext || null}
              onChange={(v) => set("metContext", v ?? "")}
              selectedClassName={SECTION_TONES.met.solid}
              allowClear
            />
            <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
              <Field label="When">
                <Input
                  autoComplete="off"
                  type="date"
                  value={form.dateMet}
                  onChange={(e) => set("dateMet", e.target.value)}
                />
              </Field>
              <Field label="Details">
                <Textarea
                  rows={2}
                  value={form.howMet}
                  onChange={(e) => set("howMet", e.target.value)}
                  placeholder="Google NYC event, introduced by Alex…"
                />
              </Field>
            </div>
          </Section>

          <Section tone="relationship" icon={HeartHandshake} title="Relationship">
            <div className="grid gap-3 sm:grid-cols-2">
              <StrengthDots
                value={strengthRated ? form.relationshipScore : null}
                onChange={(v) => {
                  setStrengthRated(true);
                  set("relationshipScore", v);
                }}
                dotClassName={SECTION_TONES.relationship.dot}
              />
              <ChoicePills
                label="Priority"
                options={PRIORITY_OPTIONS}
                value={form.priorityLevel}
                onChange={(v) => set("priorityLevel", v ?? 0)}
                selectedClassName={SECTION_TONES.relationship.solid}
              />
            </div>
            <TagInput
              value={form.tagNames}
              onChange={(v) => set("tagNames", v)}
              chipClassName={SECTION_TONES.relationship.chip}
              placeholder="fintech, mentor…"
            />
          </Section>

          <Section tone="about" icon={NotebookPen} title="About">
            <Field label="Industry">
              <Input
                autoComplete="off"
                value={form.industry}
                onChange={(e) => set("industry", e.target.value)}
                placeholder="Cloud computing, venture capital…"
              />
            </Field>
            <Field label="Shared interests" description="One per line">
              <Textarea
                rows={2}
                value={form.sharedInterests}
                onChange={(e) => set("sharedInterests", e.target.value)}
                placeholder={"AI agents\nClimbing"}
              />
            </Field>
            <Field label="Notes">
              <Textarea
                rows={4}
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
              />
            </Field>
          </Section>
        </>
      )}
      <div
        className={cn(
          "space-y-2",
          pinnedActions &&
            "sticky bottom-0 z-10 -mx-4 border-t border-border/60 bg-popover/95 px-4 py-3 supports-backdrop-filter:bg-popover/80 supports-backdrop-filter:backdrop-blur-md",
        )}
      >
        <FormError>{formError}</FormError>
        <div className="flex items-center gap-3">
          {compact ? null : (
            <span className="hidden text-xs text-muted-foreground sm:inline">
              <kbd className="font-sans">⌘↵</kbd> to save
            </span>
          )}
          <Button
            type="submit"
            disabled={pending || lookingUp}
            className={cn("bg-primary text-primary-foreground hover:bg-primary/90", !compact && "ml-auto")}
          >
            {pending ? "Saving…" : contactId ? "Save changes" : "Create contact"}
          </Button>
        </div>
      </div>
    </form>
  );
}

const PRIORITY_OPTIONS = [
  { value: 0, label: "None" },
  { value: 1, label: "Low" },
  { value: 2, label: "Medium" },
  { value: 3, label: "High" },
] as const;

/**
 * Each group's tint. `box` is the card, `title` its heading (700 on light, 300 on dark, the
 * same pairing the app's status pills use), `solid` a selected pill, `dot`/`chip` the
 * relationship marks. Literal strings so Tailwind's scanner sees every class.
 */
const SECTION_TONES = {
  work: { box: "bg-teal-500/8 ring-teal-600/15", title: "text-teal-700 dark:text-teal-300" },
  reach: { box: "bg-sky-500/8 ring-sky-600/15", title: "text-sky-700 dark:text-sky-300" },
  met: {
    box: "bg-amber-500/10 ring-amber-600/20",
    title: "text-amber-800 dark:text-amber-300",
    solid: "bg-amber-600 text-white dark:bg-amber-500 dark:text-amber-950",
  },
  relationship: {
    box: "bg-rose-500/8 ring-rose-600/15",
    title: "text-rose-700 dark:text-rose-300",
    solid: "bg-rose-600 text-white dark:bg-rose-500 dark:text-rose-950",
    dot: "bg-rose-500",
    chip: "bg-rose-500/12 text-rose-800 dark:text-rose-200",
  },
  about: { box: "bg-muted/50 ring-border/70", title: "text-muted-foreground" },
} as const;

function Section({
  tone,
  icon: Icon,
  title,
  children,
}: {
  tone: keyof typeof SECTION_TONES;
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  const t = SECTION_TONES[tone];
  return (
    <section
      aria-label={title}
      className={cn(
        "space-y-3 rounded-2xl p-3.5 ring-1",
        // Fields sit on the card colour so they stand off the tint.
        "[&_[data-slot=input]]:bg-card [&_[data-slot=org-field]]:bg-card [&_[data-slot=textarea]]:bg-card",
        t.box,
      )}
    >
      <h3 className={cn("flex items-center gap-1.5 text-xs font-semibold tracking-wide", t.title)}>
        <Icon className="size-3.5" aria-hidden />
        {title}
      </h3>
      {children}
    </section>
  );
}
