"use client";
import { useCallback, useRef, useState, useTransition } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Mail, MessageCircle, Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Search } from "lucide-react";
import {
  createOutreachCampaign,
  interpretOutreachBrief,
  saveOutreachSearchKey,
  upgradeOutreachCampaign,
} from "@/actions/outreach-v2";
import type { settingsFor } from "@/lib/outreach-v2/service";
import type { Brief, Sender } from "@/lib/outreach-v2/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AudienceCriteria } from "./outreach-v2-audience";
type Setup = Awaited<ReturnType<typeof settingsFor>>;
export function OutreachSetup({
  settings,
  legacy,
}: {
  settings: Setup;
  legacy?: {
    id: string;
    name: string;
    description: string;
    outcome: string;
    channel: "email" | "linkedin";
  };
}) {
  const router = useRouter();
  const reduced = useReducedMotion();
  const [step, setStep] = useState(0);
  const focusedStep = useRef(0);
  const focusStep = useCallback(
    (node: HTMLHeadingElement | null) => {
      if (node && focusedStep.current !== step) {
        focusedStep.current = step;
        node.focus({ preventScroll: true });
        node.scrollIntoView({ block: "nearest" });
      }
    },
    [step],
  );
  const [direction, setDirection] = useState(1);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [funding, setFunding] = useState<"hosted" | "personal">("hosted");
  const [interpreted, setInterpreted] = useState("");
  function go(next: number) {
    setDirection(next > step ? 1 : -1);
    setStep(next);
    setFields({});
    setError("");
  }
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [description, setDescription] = useState(legacy?.description ?? ""),
    [outcome, setOutcome] = useState(legacy?.outcome ?? ""),
    [name, setName] = useState(legacy?.name ?? ""),
    [channel, setChannel] = useState<"email" | "linkedin">(
      legacy?.channel ?? "email",
    ),
    [brief, setBrief] = useState<Brief | null>(null);
  const fallback: Sender = {
    transport: settings.gmail?.canSend
      ? "gmail"
      : settings.outlook?.canSend
        ? "outlook"
        : "gmail_web",
    address: settings.gmail?.canSend
      ? settings.gmail.address
      : settings.outlook?.canSend
        ? settings.outlook.address
        : "",
    introduction: "",
    signature: "",
    invitationLimit: 200,
  };
  const [sender, setSender] = useState<Sender>(
    legacy?.channel === "linkedin"
      ? (settings.defaults.find((s) => s.transport === "linkedin") ?? {
          ...fallback,
          transport: "linkedin",
          address: "",
        })
      : (settings.defaults.find((s) => s.transport !== "linkedin") ?? fallback),
  );
  function transport(value: Sender["transport"]) {
    const known = settings.defaults.find((s) => s.transport === value);
    setSender(
      known ?? {
        ...sender,
        transport: value,
        address:
          value === "gmail"
            ? (settings.gmail?.address ?? "")
            : value === "outlook"
              ? (settings.outlook?.address ?? "")
              : "",
      },
    );
  }
  function act(work: () => Promise<void>) {
    setError("");
    start(async () => {
      try {
        await work();
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Something went wrong. Try again.",
        );
      }
    });
  }
  return (
    <div className="space-y-7 pb-24">
      <nav
        aria-label="Campaign setup"
        className="flex flex-wrap items-center gap-2 border-b pb-5"
      >
        {["Purpose", "Channel & sender", "Confirm audience"].map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            <button
              disabled={i > step || pending}
              onClick={() => go(i)}
              aria-current={step === i ? "step" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-2 text-sm",
                step === i
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-full text-xs",
                  step === i
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted",
                )}
              >
                {i < step ? <Check size={13} /> : i + 1}
              </span>
              {label}
            </button>
            {i < 2 && (
              <ChevronRight size={14} className="text-muted-foreground" />
            )}
          </div>
        ))}
      </nav>
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0">
          <AnimatePresence mode="wait" initial={false} custom={direction}>
            <motion.div
              key={step}
              custom={direction}
              initial={reduced ? false : { opacity: 0, x: direction * 18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={
                reduced ? { opacity: 1 } : { opacity: 0, x: direction * -12 }
              }
              transition={{ duration: reduced ? 0 : 0.22 }}
              className="space-y-6"
            >
              <div>
                <h2
                  ref={focusStep}
                  tabIndex={-1}
                  className="font-heading text-2xl text-ink outline-none"
                >
                  {
                    [
                      "Start with a purpose",
                      "Make it personal",
                      "Here’s who we’ll look for",
                    ][step]
                  }
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {
                    [
                      "Tell us who you hope to meet and what you’d like to make happen.",
                      "Choose how you’ll reach out and give your introductions a familiar voice.",
                      "Refine the audience before research. Requirements decide eligibility; preferences guide ranking.",
                    ][step]
                  }
                </p>
              </div>
              {step === 0 && (
                <>
                  <label className="block space-y-2">
                    <span className="font-medium">
                      What would you like to make happen?
                    </span>
                    <Textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={6}
                      maxLength={5000}
                      aria-invalid={Boolean(fields.description)}
                      aria-describedby="description-error"
                      placeholder="I’m exploring product design roles in climate technology. I’d like to meet designers working on energy products in New York."
                    />
                    {fields.description && (
                      <p
                        id="description-error"
                        role="alert"
                        className="text-sm text-destructive"
                      >
                        {fields.description}
                      </p>
                    )}
                  </label>
                  <label className="block space-y-2">
                    <span className="font-medium">
                      What would a useful reply look like?
                    </span>
                    <Input
                      aria-invalid={Boolean(fields.outcome)}
                      aria-describedby="outcome-error"
                      maxLength={1000}
                      value={outcome}
                      onChange={(e) => setOutcome(e.target.value)}
                      placeholder="An introduction or a short conversation about their experience"
                    />
                    {fields.outcome && (
                      <p
                        id="outcome-error"
                        role="alert"
                        className="text-sm text-destructive"
                      >
                        {fields.outcome}
                      </p>
                    )}
                  </label>
                  <label className="block space-y-2">
                    <span className="font-medium">Campaign name</span>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Climate design introductions (optional)"
                      maxLength={160}
                    />
                  </label>
                  <Button
                    disabled={pending}
                    onClick={() => {
                      const errors: Record<string, string> = {};
                      if (description.trim().length < 10)
                        errors.description =
                          "Describe your campaign in at least 10 characters.";
                      if (outcome.trim().length < 3)
                        errors.outcome = "Add the outcome you’re hoping for.";
                      setFields(errors);
                      if (!Object.keys(errors).length) go(1);
                    }}
                  >
                    Choose channel & sender
                    <ArrowRight size={16} />
                  </Button>
                </>
              )}
              {step === 1 && (
                <>
                  <fieldset className="space-y-3">
                    <legend className="font-medium">Choose one channel</legend>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(["email", "linkedin"] as const).map((value) => (
                        <label
                          key={value}
                          className={cn(
                            "relative flex cursor-pointer items-center gap-3 rounded-xl border p-4 transition-colors",
                            channel === value
                              ? "border-primary bg-accent/40"
                              : "hover:bg-muted/50",
                          )}
                        >
                          <input
                            type="radio"
                            disabled={Boolean(legacy)}
                            name="channel"
                            checked={channel === value}
                            onChange={() => {
                              setChannel(value);
                              transport(
                                value === "linkedin"
                                  ? "linkedin"
                                  : fallback.transport,
                              );
                            }}
                          />
                          {value === "email" ? (
                            <Mail size={20} />
                          ) : (
                            <MessageCircle size={20} />
                          )}
                          <span className="font-medium">
                            {value === "email"
                              ? "Email"
                              : "LinkedIn invitations"}
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block space-y-2">
                      <span>Sending method</span>
                      <select
                        className="w-full rounded-md border bg-background p-2"
                        value={sender.transport}
                        onChange={(e) =>
                          transport(e.target.value as Sender["transport"])
                        }
                      >
                        {channel === "linkedin" ? (
                          <option value="linkedin">
                            Chrome browser session
                          </option>
                        ) : (
                          <>
                            <option
                              value="gmail"
                              disabled={!settings.gmail?.canSend}
                            >
                              Connected Gmail
                              {!settings.gmail?.canSend
                                ? " — connect in Settings"
                                : ""}
                            </option>
                            <option
                              value="outlook"
                              disabled={!settings.outlook?.canSend}
                            >
                              Connected Outlook
                              {!settings.outlook?.canSend
                                ? " — reconnect in Settings"
                                : ""}
                            </option>
                            <option value="gmail_web">Gmail in Chrome</option>
                            <option value="outlook_web">
                              Outlook in Chrome
                            </option>
                          </>
                        )}
                      </select>
                    </label>
                    <label className="block space-y-2">
                      <span>
                        {channel === "linkedin"
                          ? "Your LinkedIn profile URL"
                          : "Sending email address"}
                      </span>
                      <Input
                        aria-invalid={Boolean(fields.address)}
                        aria-describedby="sender-error"
                        value={sender.address}
                        disabled={["gmail", "outlook"].includes(
                          sender.transport,
                        )}
                        onChange={(e) =>
                          setSender({ ...sender, address: e.target.value })
                        }
                        placeholder={
                          channel === "linkedin"
                            ? "https://www.linkedin.com/in/your-profile"
                            : "you@example.com"
                        }
                      />
                    </label>
                  </div>
                  {fields.address && (
                    <p
                      id="sender-error"
                      role="alert"
                      className="text-sm text-destructive"
                    >
                      {fields.address}
                    </p>
                  )}
                  <label className="block space-y-2">
                    <span>Your introduction</span>
                    <Textarea
                      value={sender.introduction}
                      onChange={(e) =>
                        setSender({ ...sender, introduction: e.target.value })
                      }
                      placeholder="A little about you and the experience you want to share"
                      rows={3}
                      maxLength={4000}
                    />
                  </label>
                  {channel === "email" ? (
                    <label className="block space-y-2">
                      <span>Email signature</span>
                      <Textarea
                        maxLength={2000}
                        value={sender.signature}
                        onChange={(e) =>
                          setSender({ ...sender, signature: e.target.value })
                        }
                        placeholder="Your name, role, and preferred contact details"
                        rows={3}
                      />
                    </label>
                  ) : (
                    <label className="block space-y-2">
                      <span>Invitation character limit</span>
                      <select
                        value={sender.invitationLimit}
                        onChange={(e) =>
                          setSender({
                            ...sender,
                            invitationLimit: Number(e.target.value) as
                              200 | 300,
                          })
                        }
                        className="ml-3 rounded-md border bg-background p-2"
                      >
                        <option value={200}>200 — default / basic</option>
                        <option value={300}>
                          300 — when available on your account
                        </option>
                      </select>
                    </label>
                  )}
                  <p className="text-sm text-muted-foreground">
                    Browser sending needs the Orbit Chrome extension and an
                    active session. Connected email can continue when you close
                    Orbit.
                  </p>
                  <div className="flex justify-between gap-3">
                    <Button
                      variant="ghost"
                      disabled={pending}
                      onClick={() => go(0)}
                    >
                      <ArrowLeft size={16} />
                      Purpose
                    </Button>
                    <Button
                      disabled={pending}
                      onClick={() => {
                        const valid =
                          channel === "email"
                            ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender.address)
                            : /^https:\/\/(www\.)?linkedin\.com\/in\/[^/]+/.test(
                                sender.address,
                              );
                        if (!valid) {
                          setFields({
                            address:
                              channel === "email"
                                ? "Enter a valid sending email address."
                                : "Enter your LinkedIn profile URL.",
                          });
                          return;
                        }
                        act(async () => {
                          const key = description + "\n" + outcome;
                          if (!brief || interpreted !== key) {
                            setBrief(
                              await interpretOutreachBrief(
                                description,
                                outcome,
                              ),
                            );
                            setInterpreted(key);
                          }
                          go(2);
                        });
                      }}
                    >
                      {pending
                        ? "Understanding your audience…"
                        : "Review audience"}
                      <ArrowRight size={16} />
                    </Button>
                  </div>
                </>
              )}
              {step === 2 && brief && (
                <>
                  <AudienceCriteria value={brief} onChange={setBrief} />
                  <div className="space-y-3 border-t pt-5">
                    <label className="block text-sm font-medium">
                      Research funding
                      <select
                        className="mt-2 block w-full rounded-lg border bg-background p-3 font-normal"
                        value={funding}
                        onChange={(e) =>
                          setFunding(e.target.value as "hosted" | "personal")
                        }
                      >
                        <option value="hosted">
                          Orbit allowance · {settings.credits.remaining} credits
                          remaining
                        </option>
                        <option value="personal">My Brave + Apollo keys</option>
                      </select>
                    </label>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      One credit covers one person’s research attempt. You’ll
                      choose how many people to research next. Personal
                      credentials never fall back to Orbit’s allowance.
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-between gap-3">
                    <Button
                      variant="ghost"
                      disabled={pending}
                      onClick={() => go(1)}
                    >
                      <ArrowLeft size={16} />
                      Sender
                    </Button>
                    <Button
                      disabled={
                        pending ||
                        !brief.criteria.length ||
                        brief.criteria.some((c) => !c.value.trim())
                      }
                      onClick={() =>
                        act(async () => {
                          const id = legacy
                            ? (await upgradeOutreachCampaign(
                                legacy.id,
                                sender,
                                { ...brief, confirmed: true },
                              ),
                              legacy.id)
                            : await createOutreachCampaign({
                                name,
                                brief: { ...brief, confirmed: true },
                                sender,
                                channel,
                              });
                          router.push(`/outreach/${id}?funding=${funding}`);
                          router.refresh();
                        })
                      }
                    >
                      <Search size={16} />
                      {pending
                        ? "Saving campaign…"
                        : legacy
                          ? "Upgrade & review drafts"
                          : "Create campaign"}
                    </Button>
                  </div>
                </>
              )}
            </motion.div>
          </AnimatePresence>
          {error && (
            <p
              role="alert"
              className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          )}
        </div>
        <aside
          className="sticky top-6 hidden rounded-xl bg-muted/45 p-6 lg:block"
          aria-label="Campaign summary"
        >
          <h3 className="font-heading text-xl text-ink">
            {name || "Your next conversation"}
          </h3>
          <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
            {description || "A clear purpose makes for a better introduction."}
          </p>
          <dl className="mt-6 space-y-4 border-t pt-5 text-sm">
            <div>
              <dt className="text-muted-foreground">Hoping for</dt>
              <dd className="mt-1 break-words">
                {outcome || "A meaningful connection"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Channel</dt>
              <dd className="mt-1">
                {channel === "email" ? "Email" : "LinkedIn invitation"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Sending as</dt>
              <dd className="mt-1 break-all">
                {sender.address || "Choose your sender"}
              </dd>
            </div>
          </dl>
          <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
            You’ll review every message before it joins the sending queue.
          </p>
        </aside>
      </div>
      <ResearchSettings settings={settings} />
    </div>
  );
}

export function ResearchSettings({ settings }: { settings: Setup }) {
  const [key, setKey] = useState(""),
    [message, setMessage] = useState("");
  const [pending, start] = useTransition();
  return (
    <details className="border-t pt-5">
      <summary className="cursor-pointer text-sm font-medium">
        Research allowance & personal keys
      </summary>
      <div className="mt-4 space-y-3 text-sm">
        <p>
          {settings.credits.remaining} of {settings.credits.limit} credits
          remaining ·{" "}
          {settings.credits.period === "lifetime"
            ? "one-time allowance"
            : "this month"}
        </p>
        <p>
          One credit covers one bounded person-research attempt. Personal keys
          are billed directly by your providers.
        </p>
        <p>
          Apollo:{" "}
          {settings.hasPersonalApollo
            ? "personal key configured"
            : "add your personal key in Settings → Outreach"}
          . Brave:{" "}
          {settings.hasPersonalBrave
            ? "personal key configured"
            : "not configured"}
          .
        </p>
        <label className="block space-y-2">
          <span>Personal Brave Search API key</span>
          <Input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Enter a key to replace the saved key"
          />
        </label>
        <Button
          variant="outline"
          disabled={pending || !key}
          onClick={() =>
            start(async () => {
              try {
                await saveOutreachSearchKey(key);
                setKey("");
                setMessage(
                  "Key saved. Personal funding will use your own Brave and Apollo keys.",
                );
              } catch (e) {
                setMessage(
                  e instanceof Error ? e.message : "Could not save key.",
                );
              }
            })
          }
        >
          Save key
        </Button>
        <p role="status">{message}</p>
      </div>
    </details>
  );
}
