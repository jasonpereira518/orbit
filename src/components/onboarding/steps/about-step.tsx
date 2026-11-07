"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import {
  ArrowRight,
  Backpack,
  BookOpen,
  Briefcase,
  Building2,
  CalendarDays,
  Check,
  ChartLine,
  Code,
  Compass,
  FlaskConical,
  GraduationCap,
  Info,
  Landmark,
  LayoutGrid,
  Link as LinkIcon,
  LoaderCircle,
  MessageSquareQuote,
  Palette,
  Pencil,
  Presentation,
  Rocket,
  Search,
  Shuffle,
  Sparkles,
  Sprout,
  Target,
  Telescope,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { saveAboutYou } from "@/actions/about-you";
import {
  CARD,
  ChoiceRow,
  GroupLabel,
  Note,
  StaggerItem,
  StepFooter,
  StepLayout,
  ToggleGroup,
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
  asksForMajors,
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

const AIM_ICONS: Record<AimKind, LucideIcon> = {
  internship: Backpack,
  full_time: Briefcase,
  switch_roles: Shuffle,
  grow: Sprout,
  grad_school: GraduationCap,
  explore: Compass,
  build: Rocket,
};
const FIELD_ICONS: Record<FieldKind, LucideIcon> = {
  product: LayoutGrid,
  software: Code,
  finance: ChartLine,
  consulting: Presentation,
  design: Palette,
  research: FlaskConical,
};
const TIMELINE_ICONS: Record<Timeline, LucideIcon> = {
  this_term: Zap,
  this_year: CalendarDays,
  no_rush: Telescope,
};

type Screen = "link" | "taps" | "confirm";
/** null: no LinkedIn given, so no lookup and no "couldn't confirm" line. */
type LookupState = null | "pending" | AboutLookup;
type Row = "headline" | "majors" | "schools" | "goal" | "intro";

const splitList = (text: string) => text.split(",").map((s) => s.trim()).filter(Boolean);

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
  // The first row is "Your major(s)" for students and "What you do now" for people already
  // working. Only the row on screen is sent; the hidden one's lookup value still fills an
  // empty profile through the save's fill-only-empty rule, as the headline always did.
  const majorsRow = asksForMajors(aim);
  const headline = edits.headline ?? prefill?.headline ?? "";
  const majorsText = edits.majors ?? prefill?.majors.join(", ") ?? "";
  const schools = edits.schools ?? prefill?.schools.join(", ") ?? "";
  const answers = {
    aim,
    timeline,
    field,
    companies,
    schools: splitList(schools),
    majors: majorsRow ? splitList(majorsText) : [],
    headline: majorsRow ? (prefill?.headline ?? null) : headline.trim() || null,
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
    // Not awaited, and a route rather than a server action: Next runs a client's actions one at a
    // time, so an action here would hold "Looks right" behind the web search.
    void fetch("/api/onboarding/self-lookup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-orbit-research": "1" },
      body: JSON.stringify({ linkedinUrl: parsed.url }),
    })
      .then((r) => (r.ok ? (r.json() as Promise<AboutLookup | { status: "invalid" }>) : null))
      .then((res): AboutLookup => (!res || res.status === "invalid" ? { status: "unavailable" } : res))
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
        edited: {
          headline: !majorsRow && edits.headline !== undefined,
          majors: majorsRow && edits.majors !== undefined,
          selfIntro: edits.intro !== undefined,
        },
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
    <StepFooter
      left={
        <Button type="button" variant="ghost" className="h-10 text-muted-foreground" disabled={busy} onClick={onSkip}>
          Skip for now
        </Button>
      }
      right={primary}
    />
  );

  return (
    <div ref={rootRef} tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
      {screen === "link" && (
        <StepLayout
          key="link"
          onBack={onBack}
          backDisabled={busy}
          eyebrow="About you · 1 of 3"
          title="Where can Orbit find you?"
          description="Paste your LinkedIn profile. Orbit looks you up in the background while you answer the next questions."
          footer={footer(null)}
        >
          <StaggerItem className={cn(CARD, "p-4 sm:p-5")}>
            <form
              noValidate
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                submitUrl();
              }}
            >
              <Field label="Your LinkedIn profile" error={urlError} description="Only your public profile. Nothing is posted or connected.">
                <div className="relative">
                  <LinkIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-primary" aria-hidden />
                  <Input
                    type="url"
                    inputMode="url"
                    autoComplete="url"
                    value={url}
                    placeholder="linkedin.com/in/your-name"
                    className="h-10 pl-9"
                    onChange={(e) => {
                      setUrl(e.target.value);
                      if (urlError) setUrlError(null);
                    }}
                  />
                </div>
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
          <StaggerItem as="div" className="mt-5 space-y-3">
            <ChoiceRow icon={Search} title="What Orbit reads">
              Your headline, where you study or work, and your field.
            </ChoiceRow>
            <ChoiceRow icon={Pencil} tone="gold" title="You approve it">
              You’ll see what Orbit understood and can change anything before it’s saved.
            </ChoiceRow>
          </StaggerItem>
        </StepLayout>
      )}

      {screen === "taps" && (
        <StepLayout
          key="taps"
          onBack={() => setScreen("link")}
          backDisabled={busy}
          eyebrow="About you · 2 of 3"
          title="What are you going for?"
          description="Three quick taps, all optional. Orbit uses them to pick who to suggest and what your drafts ask."
          footer={footer(
            <Button type="button" size="lg" className="h-10 px-4" disabled={busy} onClick={() => setScreen("confirm")}>
              Continue
              <ArrowRight className="size-4" aria-hidden />
            </Button>,
          )}
        >
          <div className="space-y-4">
            <StaggerItem>
              <ToggleGroup
                label="Your aim"
                look="tile"
                options={AIM_KINDS}
                labels={AIM_LABELS}
                icons={AIM_ICONS}
                value={aim}
                onChange={(next) => {
                  setAim(next);
                  // A field is saved only with an aim: clear it rather than drop it silently.
                  if (!next) setField(null);
                }}
              />
            </StaggerItem>

            <StaggerItem>
              <ToggleGroup
                label="Field"
                disabled={!aim}
                hint={aim ? undefined : "Pick your aim first."}
                look="chip"
                options={FIELDS}
                labels={FIELD_LABELS}
                icons={FIELD_ICONS}
                value={field}
                onChange={setField}
              />
            </StaggerItem>

            <StaggerItem className="min-w-0">
              <label htmlFor="about-company" className="block">
                <GroupLabel aside={`up to ${MAX_COMPANIES}`}>Dream companies</GroupLabel>
              </label>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <div className="flex h-10 min-w-[12rem] flex-1 items-center gap-2 rounded-full border border-input bg-card pr-1 pl-3 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 sm:max-w-xs">
                  <Building2 className="size-4 shrink-0 text-primary" aria-hidden />
                  <input
                    id="about-company"
                    value={company}
                    placeholder={companies.length >= MAX_COMPANIES ? "That’s five" : "Add a company…"}
                    className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
                    disabled={companies.length >= MAX_COMPANIES}
                    enterKeyHint="done"
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
                    variant="ghost"
                    size="sm"
                    className="h-8 rounded-full px-3"
                    disabled={!company.trim() || companies.length >= MAX_COMPANIES}
                    onClick={addCompany}
                  >
                    Add
                  </Button>
                </div>
                {companies.map((name) => (
                  <span
                    key={name}
                    className="inline-flex h-9 max-w-full min-w-0 items-center gap-1 rounded-full border border-gold/30 bg-gold/10 pr-1 pl-3 text-[0.8125rem]"
                  >
                    <span className="min-w-0 truncate">{name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${name}`}
                      onClick={() => setCompanies(companies.filter((c) => c !== name))}
                      className="relative grid size-7 shrink-0 tap-target place-items-center rounded-full text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  </span>
                ))}
              </div>
            </StaggerItem>

            <StaggerItem>
              <ToggleGroup
                label="When"
                look="segment"
                options={TIMELINES}
                labels={TIMELINE_LABELS}
                icons={TIMELINE_ICONS}
                value={timeline}
                onChange={setTimeline}
              />
            </StaggerItem>
          </div>
        </StepLayout>
      )}

      {screen === "confirm" && (
        <StepLayout
          key="confirm"
          onBack={() => setScreen("taps")}
          backDisabled={busy}
          eyebrow="About you · 3 of 3"
          title="Here’s what Orbit understood"
          description="Change anything that’s off. Orbit only fills what’s empty in your profile."
          footer={footer(
            <Button type="button" size="lg" className="h-10 px-4" disabled={busy} onClick={confirm}>
              {saving ? "Saving…" : "Looks right"}
              <Check className="size-4" aria-hidden />
            </Button>,
          )}
        >
          <StaggerItem>
            <LookupLine lookup={lookup} />
          </StaggerItem>
          <StaggerItem className={cn(CARD, "mt-3 space-y-3 p-4 sm:p-5")}>
            <div className="grid gap-3 sm:grid-cols-2">
              {majorsRow ? (
                <Field label={<RowLabel icon={BookOpen}>Your major(s)</RowLabel>}>
                  <Input
                    value={majorsText}
                    placeholder="Computer Science, Economics"
                    className="h-10"
                    onChange={(e) => setEdits({ ...edits, majors: e.target.value })}
                  />
                </Field>
              ) : (
                <Field label={<RowLabel icon={Briefcase}>What you do now</RowLabel>}>
                  <Input
                    value={headline}
                    placeholder="Product manager at Stripe"
                    className="h-10"
                    onChange={(e) => setEdits({ ...edits, headline: e.target.value })}
                  />
                </Field>
              )}
              <Field label={<RowLabel icon={Landmark}>School</RowLabel>}>
                <Input
                  value={schools}
                  placeholder="University of North Carolina"
                  className="h-10"
                  onChange={(e) => setEdits({ ...edits, schools: e.target.value })}
                />
              </Field>
            </div>
            <Field label={<RowLabel icon={Target}>Your goal</RowLabel>}>
              <Input
                value={goal}
                placeholder="Land a product internship in the next year."
                className="h-10"
                onChange={(e) => setEdits({ ...edits, goal: e.target.value })}
              />
            </Field>
            <Field
              label={<RowLabel icon={MessageSquareQuote}>How Orbit introduces you</RowLabel>}
              description="The opening line Orbit uses in your drafts."
            >
              <Input
                value={intro}
                placeholder="Computer Science student at UNC, aiming for product internships."
                className="h-10"
                onChange={(e) => setEdits({ ...edits, intro: e.target.value })}
              />
            </Field>
            <FormError>{saveError}</FormError>
          </StaggerItem>
        </StepLayout>
      )}
    </div>
  );
}

function RowLabel({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 text-[0.8125rem] font-semibold text-ink">
      <Icon className="size-3.5 text-gold" aria-hidden />
      {children}
    </span>
  );
}

/** The lookup's state, in the note style: gold when it found the person, muted otherwise. */
function LookupLine({ lookup }: { lookup: LookupState }) {
  if (lookup === null) return null;
  if (lookup === "pending") {
    return (
      <Note icon={LoaderCircle} tone="muted" role="status">
        Looking you up on LinkedIn… these fill in when it’s done.
      </Note>
    );
  }
  if (lookup.status === "confident") {
    return (
      <Note icon={Sparkles} role="status">
        Found you on LinkedIn: filled in from your public profile.
      </Note>
    );
  }
  return (
    <Note icon={Info} tone="muted" role="status">
      We couldn’t confirm this is you, so nothing was filled in from LinkedIn.
    </Note>
  );
}
