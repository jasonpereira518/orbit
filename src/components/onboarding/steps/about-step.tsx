"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { ArrowRight, X } from "lucide-react";
import { lookUpMyself, saveAboutYou } from "@/actions/about-you";
import {
  BackButton,
  Stagger,
  StaggerItem,
  StepHeading,
} from "@/components/onboarding/onboarding-ui";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  AIM_KINDS,
  AIM_LABELS,
  FIELDS,
  FIELD_LABELS,
  TIMELINES,
  TIMELINE_LABELS,
  composeGoalSentence,
  composeSelfIntro,
  parseOwnLinkedInUrl,
  type AimKind,
  type Field as FieldKind,
  type Timeline,
} from "@/lib/about-you";
import type { AboutLookup } from "@/lib/about-you-server";
import { friendlyError } from "@/lib/errors";
import { cn } from "@/lib/utils";

const MAX_COMPANIES = 5;

type Screen = "link" | "taps" | "confirm";
/** null: no LinkedIn given, so no lookup and no "couldn't confirm" line. */
type LookupState = null | "pending" | AboutLookup;
type Row = "headline" | "schools" | "goal" | "intro";

/**
 * "About you": a LinkedIn URL, three tap groups, then one card of what Orbit understood. The
 * three screens are local state, not stored steps: a refresh resumes at the step's start.
 *
 * The self-lookup is fired on screen 1 and never awaited (a web search can take 20 seconds).
 * Screen 3 reads it whenever it lands; a row the person already edited keeps their text, and
 * anything short of a `confident` match fills nothing and is not sent to the save. A newer
 * lookup, "I don't use LinkedIn" or Confirm bumps `lookupSeq`, so a stale answer is dropped.
 */
export function AboutStep({
  initialUrl,
  pending,
  onNext,
  onSkip,
  onBack,
}: {
  initialUrl: string | null;
  pending: boolean;
  onNext: () => void;
  onSkip: () => void;
  onBack: () => void;
}) {
  const [screen, setScreen] = useState<Screen>("link");
  const [url, setUrl] = useState(initialUrl ?? "");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [lookup, setLookup] = useState<LookupState>(null);
  const lookupSeq = useRef(0);

  const [aim, setAim] = useState<AimKind | null>(null);
  const [field, setField] = useState<FieldKind | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [companies, setCompanies] = useState<string[]>([]);
  const [company, setCompany] = useState("");

  // A row's own text once the person types in it; until then it follows the lookup and taps.
  const [edits, setEdits] = useState<Partial<Record<Row, string>>>({});
  const [saving, startSaving] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);
  const busy = pending || saving;

  // The control that moved the screen on has just unmounted: land focus at the new screen.
  const rootRef = useRef<HTMLDivElement>(null);
  const firstScreen = useRef(true);
  useEffect(() => {
    if (firstScreen.current) {
      firstScreen.current = false;
      return;
    }
    rootRef.current?.focus({ preventScroll: true });
  }, [screen]);

  const prefill = lookup && lookup !== "pending" && lookup.status === "confident" ? lookup.prefill : null;
  const headline = edits.headline ?? prefill?.headline ?? "";
  const schools = edits.schools ?? prefill?.schools.join(", ") ?? "";
  const answers = {
    aim,
    timeline,
    field,
    companies,
    schools: schools.split(",").map((s) => s.trim()).filter(Boolean),
    headline: headline.trim() || null,
  };
  const goal = edits.goal ?? composeGoalSentence(answers) ?? "";
  const intro = edits.intro ?? composeSelfIntro(answers) ?? "";

  function submitUrl() {
    const parsed = parseOwnLinkedInUrl(url);
    if (!parsed.ok) {
      setUrlError(parsed.message);
      return;
    }
    const seq = ++lookupSeq.current;
    setLookup("pending");
    // Not awaited: screen 2 is usable while this runs.
    void lookUpMyself(parsed.url)
      .then((res): AboutLookup => (res.status === "invalid" ? { status: "unavailable" } : res))
      .catch((): AboutLookup => ({ status: "unavailable" }))
      .then((res) => {
        if (seq === lookupSeq.current) setLookup(res);
      });
    setScreen("taps");
  }

  function noLinkedIn() {
    lookupSeq.current++;
    setLookup(null);
    setScreen("taps");
  }

  function addCompany() {
    const name = company.trim();
    if (!name || companies.length >= MAX_COMPANIES) return;
    if (!companies.some((c) => c.toLowerCase() === name.toLowerCase())) setCompanies([...companies, name]);
    setCompany("");
  }

  function confirm() {
    setSaveError(null);
    startSaving(async () => {
      const res = await saveAboutYou({
        ...answers,
        goalSentence: goal.trim() || null,
        selfIntro: intro.trim() || null,
        edited: { headline: edits.headline !== undefined, selfIntro: edits.intro !== undefined },
        prefill,
      }).catch((err: unknown) => ({ ok: false as const, error: friendlyError(err, "We couldn’t save that. Try again.") }));
      if (!res.ok) {
        setSaveError(res.error);
        return;
      }
      // Saved: a lookup still in flight must not change anything now.
      lookupSeq.current++;
      onNext();
    });
  }

  const footer = (primary: ReactNode) => (
    <StaggerItem className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
      <Button type="button" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={onSkip}>
        Skip for now
      </Button>
      {primary}
    </StaggerItem>
  );

  return (
    <div ref={rootRef} tabIndex={-1} className="outline-none">
      {screen === "link" && (
        <Stagger key="link" className="mx-auto max-w-2xl space-y-6">
          <div className="space-y-4">
            <StaggerItem>
              <BackButton onClick={onBack} disabled={busy} />
            </StaggerItem>
            <StepHeading eyebrow="About you" title="Where can Orbit find you?">
              Your LinkedIn profile helps Orbit fill in what you do now. It looks you up while you
              answer the next three questions.
            </StepHeading>
          </div>
          <StaggerItem>
            <form
              noValidate
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                submitUrl();
              }}
            >
              <Field label="Your LinkedIn profile" error={urlError}>
                <Input
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  value={url}
                  placeholder="linkedin.com/in/your-name"
                  onChange={(e) => {
                    setUrl(e.target.value);
                    if (urlError) setUrlError(null);
                  }}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" size="lg" className="h-10 px-4" disabled={busy || !url.trim()}>
                  Continue
                  <ArrowRight className="size-4" aria-hidden />
                </Button>
                <Button type="button" variant="outline" size="lg" className="h-10 px-4" disabled={busy} onClick={noLinkedIn}>
                  I don’t use LinkedIn
                </Button>
              </div>
            </form>
          </StaggerItem>
          {footer(null)}
        </Stagger>
      )}

      {screen === "taps" && (
        <Stagger key="taps" className="mx-auto max-w-2xl space-y-6">
          <div className="space-y-4">
            <StaggerItem>
              <BackButton onClick={() => setScreen("link")} disabled={busy} />
            </StaggerItem>
            <StepHeading eyebrow="About you" title="What are you going for?">
              Three taps, all optional. Orbit uses them to pick who to suggest and what your
              drafts ask for.
            </StepHeading>
          </div>

          <StaggerItem>
            <ChipGroup
              label="What you’re going for"
              options={AIM_KINDS}
              labels={AIM_LABELS}
              value={aim}
              onChange={setAim}
            />
          </StaggerItem>

          <StaggerItem className="space-y-3">
            <ChipGroup label="Field" options={FIELDS} labels={FIELD_LABELS} value={field} onChange={setField} />
            <div className="min-w-0 space-y-2">
              <Field label="Companies you’d like to work at" description={`Up to ${MAX_COMPANIES}.`}>
                <div className="flex min-w-0 gap-2">
                  <Input
                    value={company}
                    placeholder="Company name"
                    className="min-w-0 flex-1 sm:max-w-xs"
                    disabled={companies.length >= MAX_COMPANIES}
                    onChange={(e) => setCompany(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCompany();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!company.trim() || companies.length >= MAX_COMPANIES}
                    onClick={addCompany}
                  >
                    Add
                  </Button>
                </div>
              </Field>
              {companies.length > 0 && (
                <ul className="flex min-w-0 flex-wrap gap-2">
                  {companies.map((name) => (
                    <li
                      key={name}
                      className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border border-border/60 bg-card py-0.5 pr-1 pl-3 text-sm"
                    >
                      <span className="min-w-0 truncate">{name}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${name}`}
                        onClick={() => setCompanies(companies.filter((c) => c !== name))}
                        className="relative grid size-6 shrink-0 tap-target place-items-center rounded-full text-muted-foreground hover:text-foreground"
                      >
                        <X className="size-3.5" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </StaggerItem>

          <StaggerItem>
            <ChipGroup label="When" options={TIMELINES} labels={TIMELINE_LABELS} value={timeline} onChange={setTimeline} />
          </StaggerItem>

          {footer(
            <Button type="button" size="lg" className="h-10 px-4" disabled={busy} onClick={() => setScreen("confirm")}>
              Continue
              <ArrowRight className="size-4" aria-hidden />
            </Button>,
          )}
        </Stagger>
      )}

      {screen === "confirm" && (
        <Stagger key="confirm" className="mx-auto max-w-2xl space-y-6">
          <div className="space-y-4">
            <StaggerItem>
              <BackButton onClick={() => setScreen("taps")} disabled={busy} />
            </StaggerItem>
            <StepHeading eyebrow="About you" title="Here’s what Orbit understood">
              Change anything that’s off. Orbit only fills what’s empty in your profile.
            </StepHeading>
          </div>

          <StaggerItem className="space-y-4 rounded-2xl border border-border/70 bg-card p-4 sm:p-5">
            <LookupLine lookup={lookup} />
            <Field label="What you do now">
              <Input
                value={headline}
                placeholder="CS junior at UNC"
                onChange={(e) => setEdits({ ...edits, headline: e.target.value })}
              />
            </Field>
            <Field label="School(s)" description="Separate more than one with commas.">
              <Input
                value={schools}
                placeholder="University of North Carolina"
                onChange={(e) => setEdits({ ...edits, schools: e.target.value })}
              />
            </Field>
            <Field label="Your goal">
              <Input
                value={goal}
                placeholder="Land a product internship this year."
                onChange={(e) => setEdits({ ...edits, goal: e.target.value })}
              />
            </Field>
            <Field label="How Orbit introduces you" description="The opening line Orbit uses in your drafts.">
              <Input
                value={intro}
                placeholder="CS junior at UNC aiming for product internships."
                onChange={(e) => setEdits({ ...edits, intro: e.target.value })}
              />
            </Field>
            <FormError>{saveError}</FormError>
          </StaggerItem>

          {footer(
            <Button type="button" size="lg" className="h-10 px-4" disabled={busy} onClick={confirm}>
              {saving ? "Saving…" : "Looks right"}
              <ArrowRight className="size-4" aria-hidden />
            </Button>,
          )}
        </Stagger>
      )}
    </div>
  );
}

function LookupLine({ lookup }: { lookup: LookupState }) {
  if (lookup === null) return null;
  const text =
    lookup === "pending"
      ? "Looking you up on LinkedIn… these fill in when it’s done."
      : lookup.status === "confident"
        ? "Filled in from your LinkedIn profile."
        : "We couldn’t confirm this is you, so nothing was filled in from LinkedIn.";
  return (
    <p role="status" className={cn("text-sm", lookup === "pending" ? "text-muted-foreground" : "text-foreground")}>
      {text}
    </p>
  );
}

/** One-of chips: real toggle buttons, and pressing the chosen one clears it. */
function ChipGroup<T extends string>({
  label,
  options,
  labels,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T | null;
  onChange: (next: T | null) => void;
}) {
  return (
    <div role="group" aria-label={label} className="min-w-0 space-y-2">
      <p className="text-sm font-medium text-ink">{label}</p>
      <div className="flex min-w-0 flex-wrap gap-2">
        {options.map((option) => {
          const on = value === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? null : option)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-sm transition-[border-color,background-color,color,transform] duration-200 active:scale-[0.97]",
                "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                on
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border/70 bg-card text-foreground hover:border-primary/40",
              )}
            >
              {labels[option]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
