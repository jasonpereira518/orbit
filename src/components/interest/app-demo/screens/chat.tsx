"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  CircleDashed,
  Clock,
  Copy,
  Handshake,
  Mail,
  Mic,
  NotebookPen,
  PanelLeftClose,
  Pencil,
  PenLine,
  Plus,
  Sparkles,
  Undo2,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { firstName, personById } from "../demo-cast";
import { CHAT_SUGGESTIONS, type DemoStep } from "../demo-chat";
import { useDemo } from "../demo-context";
import type { ChatTurn } from "../demo-state";
import { Avatar, BTN, BTN_GHOST, BTN_PRIMARY, CARD, DISPLAY } from "../demo-ui";

type AssistantTurn = Extract<ChatTurn, { role: "assistant" }>;

/** Words land a few at a time, like the real answer streaming in — once `writing` starts. */
function useStreamedText(text: string, done: boolean, writing: boolean, onDone: () => void) {
  const words = text.split(/(\s+)/);
  const [count, setCount] = useState(0);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    if (done || !writing) return;
    let n = 0;
    const timer = window.setInterval(() => {
      n = Math.min(words.length, n + 4);
      setCount(n);
      if (n >= words.length) {
        window.clearInterval(timer);
        onDoneRef.current();
      }
    }, 45);
    return () => window.clearInterval(timer);
    // A turn streams once; its words never change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, writing]);

  return done ? text : words.slice(0, count).join("");
}

/** How long the words take to land, so the summary's total covers the writing too. */
function writeMs(text: string) {
  return Math.ceil(text.split(/(\s+)/).length / 4) * 45;
}

function formatMs(ms: number) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The small spinning mark beside the running step. */
function OrbitMark({ reduced }: { reduced: boolean }) {
  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
      <span className="size-1.5 rounded-full bg-tier-lifetime" />
      <motion.span
        className="absolute inset-0 rounded-full border border-primary/60 border-t-transparent"
        animate={reduced ? undefined : { rotate: 360 }}
        transition={{ duration: 1.1, repeat: Infinity, ease: "linear" }}
      />
    </span>
  );
}

/** The loading scene: the people this answer is touching, riding two rings. */
function OrbitScene({ ids, reduced }: { ids: string[]; reduced: boolean }) {
  const people = ids.map((id) => personById(id)!).slice(0, 6);
  const rings = [
    { r: 24, people: people.filter((_, i) => i % 2 === 0), dur: 16 },
    { r: 40, people: people.filter((_, i) => i % 2 === 1), dur: 24 },
  ];
  return (
    <div className="relative size-[96px] shrink-0" aria-hidden="true">
      <span className="absolute left-1/2 top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-tier-lifetime shadow-[0_0_14px_var(--tier-lifetime)]" />
      {rings.map((ring, ri) => (
        <motion.div
          key={ri}
          className="absolute left-1/2 top-1/2 rounded-full border border-dashed border-white/15"
          style={{ width: ring.r * 2, height: ring.r * 2, marginLeft: -ring.r, marginTop: -ring.r }}
          animate={reduced ? undefined : { rotate: ri === 0 ? 360 : -360 }}
          transition={{ duration: ring.dur, repeat: Infinity, ease: "linear" }}
        >
          <AnimatePresence>
            {ring.people.map((p, i) => {
              const a = (i / Math.max(1, ring.people.length)) * Math.PI * 2 + ri;
              return (
                <motion.div
                  key={p.id}
                  className="absolute"
                  style={{ left: ring.r + Math.cos(a) * ring.r - 9, top: ring.r + Math.sin(a) * ring.r - 9 }}
                  initial={reduced ? false : { opacity: 0, scale: 0.4 }}
                  animate={{ opacity: 1, scale: 1, rotate: reduced ? 0 : ri === 0 ? -360 : 360 }}
                  transition={{
                    opacity: { duration: 0.3 },
                    scale: { duration: 0.3 },
                    rotate: { duration: ring.dur, repeat: Infinity, ease: "linear" },
                  }}
                >
                  <Avatar person={p} size={18} />
                </motion.div>
              );
            })}
          </AnimatePresence>
        </motion.div>
      ))}
    </div>
  );
}

/**
 * What the answer is doing, while it does it — the real chat's activity card: the running
 * step as a header, finished steps ticked beneath, the orbit scene beside them. Once the
 * answer lands it folds to "Looked at N contacts · 3.1s", which opens to the full list.
 */
function Activity({ steps, at, done, totalMs }: { steps: DemoStep[]; at: number; done: boolean; totalMs: number }) {
  const { dispatch, reduced } = useDemo();
  const [liveOpen, setLiveOpen] = useState(true);
  const [finalOpen, setFinalOpen] = useState(false);
  const current = steps[Math.min(at, steps.length - 1)]!;
  const finished = steps.slice(0, at);
  const orbit = steps.slice(0, at + 1).flatMap((s) => (s.kind === "read" || s.kind === "search" ? s.refs ?? [] : []));
  const looked = new Set(steps.filter((s) => s.kind === "read").flatMap((s) => s.refs ?? []));

  if (!done) {
    return (
      <div className="rounded-xl border border-primary/30 bg-muted/50">
        <button
          type="button"
          onClick={() => setLiveOpen((v) => !v)}
          aria-expanded={liveOpen}
          className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-ink"
        >
          <OrbitMark reduced={reduced} />
          <span className="min-w-0 flex-1 text-left" aria-live="polite" aria-atomic="true">
            <AnimatePresence initial={false} mode="wait">
              <motion.span
                key={current.kind}
                className="block truncate"
                initial={reduced ? false : { opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, y: -3 }}
                transition={{ duration: 0.16 }}
              >
                {current.label}
                {current.detail && <span className="text-muted-foreground/80"> · {current.detail}</span>}
              </motion.span>
            </AnimatePresence>
          </span>
          <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", liveOpen && "rotate-180")} aria-hidden="true" />
        </button>
        {liveOpen && (
          <div className="flex items-center gap-4 px-3 pb-3">
            <ul className="min-w-0 flex-1 space-y-1.5 pl-[1.4rem]">
              {finished.map((s) => (
                <motion.li
                  key={s.kind}
                  initial={reduced ? false : { opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="relative text-xs leading-snug text-muted-foreground"
                >
                  <Check className="absolute -left-[1.15rem] top-px size-3.5 text-primary" aria-hidden="true" />
                  <span className="text-ink/80">{s.label}</span>
                  {s.detail && <span> · {s.detail}</span>}
                </motion.li>
              ))}
            </ul>
            <OrbitScene ids={[...new Set(orbit)]} reduced={reduced} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setFinalOpen((v) => !v)}
        aria-expanded={finalOpen}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-ink"
      >
        <CircleDashed className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">
          Looked at {looked.size} {looked.size === 1 ? "contact" : "contacts"} · {formatMs(totalMs)}
        </span>
        <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", finalOpen && "rotate-180")} aria-hidden="true" />
      </button>
      <AnimatePresence initial={false}>
        {finalOpen && (
          <motion.ol
            initial={reduced ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            className="mt-2 space-y-2 overflow-hidden border-l border-border/70 pl-3"
          >
            {steps.map((s) => (
              <li key={s.kind} className="text-xs text-muted-foreground">
                <span className="text-ink/80">{s.kind === "answer" ? "Wrote the answer" : s.label}</span>
                <span className="text-muted-foreground/70"> · {formatMs(s.kind === "answer" ? totalMs - steps.reduce((a, x) => a + x.ms, 0) : s.ms)}</span>
                {s.detail && <span className="block text-muted-foreground/70">{s.detail}</span>}
                {s.kind === "read" && s.refs && (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {s.refs.map((id) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => dispatch({ type: "openProfile", id })}
                        className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-ink/80 hover:bg-white/10"
                      >
                        {personById(id)!.name}
                      </button>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </motion.ol>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The real draft editor's rewrite chips, as small deterministic edits of the draft's own words. */
const REWRITES: { label: string; apply: (body: string) => string }[] = [
  { label: "Shorter", apply: (b) => b.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ") },
  { label: "Warmer", apply: (b) => (b.startsWith("Hope you") ? b : `Hope you're doing well! ${b}`) },
  { label: "More direct", apply: (b) => b.replace(/^(Hi [^—–-]+[—–-]\s*)?(sorry[^!.]*[!.]\s*)?/i, (m, hi = "") => hi) },
  { label: "More formal", apply: (b) => b.replace(/^Hi ([^—–,-]+)\s*[—–,-]\s*/, "Dear $1, ") },
];

/** What a source chip's popover quotes: the person's own entry of that type. */
function snippetFor(personId: string, label: string) {
  const p = personById(personId);
  if (!p) return "";
  const type = label.split(" · ")[0];
  return (p.timeline.find((t) => t.type === type) ?? p.timeline[0])?.note ?? p.standing;
}

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) =>
        line.trim() === "" ? (
          <span key={i} className="block h-2" />
        ) : (
          <span key={i} className={cn("block", line.startsWith("•") && "pl-3 -indent-3")}>
            {line}
          </span>
        )
      )}
    </>
  );
}

function Answer({ turn, last }: { turn: AssistantTurn; last: boolean }) {
  const { state, dispatch, reduced } = useDemo();
  const done = reduced || state.streamed.includes(turn.id);
  const steps = turn.answer.steps;
  const writingAt = steps.length - 1;
  const [at, setAt] = useState(done ? writingAt : 0);
  const [openSrc, setOpenSrc] = useState<number | null>(null);

  // A source popover closes on Escape or a press anywhere outside it, like any popover.
  useEffect(() => {
    if (openSrc === null) return;
    const outside = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-src-pop]")) setOpenSrc(null);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenSrc(null);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [openSrc]);

  // Walk the stages at their own pace, then hand over to the writing.
  useEffect(() => {
    if (done || at >= writingAt) return;
    const t = window.setTimeout(() => setAt((i) => i + 1), steps[at]!.ms);
    return () => window.clearTimeout(t);
  }, [at, done, steps, writingAt]);

  const text = useStreamedText(turn.answer.text, done, at >= writingAt, () => dispatch({ type: "streamed", id: turn.id }));
  const finished = done;
  const draftTo = personById(turn.answer.draft?.personId);
  const totalMs = steps.reduce((a, s) => a + s.ms, 0) + writeMs(turn.answer.text);

  return (
    <div className="flex gap-3">
      <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
        <Sparkles className="size-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 space-y-2.5">
        <Activity steps={steps} at={at} done={done} totalMs={totalMs} />
        {text && (
          <p className="text-sm leading-relaxed text-ink">
            <Paragraphs text={text} />
          </p>
        )}

        {finished && (
          <motion.div initial={reduced ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Sources</span>
              {turn.answer.sources.map((s, i) => {
                const p = personById(s.personId)!;
                const open = openSrc === i;
                return (
                  <span key={i} data-src-pop className="relative">
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-label={`Source ${i + 1}: ${p.name}, ${s.label}`}
                      onClick={() => setOpenSrc(open ? null : i)}
                      className={cn(
                        "inline-flex size-5 items-center justify-center rounded-full text-[11px] tabular-nums transition-colors",
                        open ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-ink"
                      )}
                    >
                      {i + 1}
                    </button>
                    {open && (
                      <div role="dialog" className="absolute left-0 top-full z-30 mt-2 w-64 rounded-xl border border-border bg-popover p-3 text-left shadow-xl">
                        <div className="flex items-center gap-2.5">
                          <Avatar person={p} size={28} />
                          <div className="min-w-0">
                            <button type="button" onClick={() => dispatch({ type: "openProfile", id: p.id })} className="block truncate text-sm font-medium text-ink hover:underline">
                              {p.name}
                            </button>
                            <p className="text-xs text-muted-foreground">{s.label}</p>
                          </div>
                        </div>
                        <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-ink/80">“{snippetFor(s.personId, s.label).replace(/^[“"]+|[”"]+$/g, "")}”</p>
                      </div>
                    )}
                  </span>
                );
              })}
            </div>

            {turn.answer.draft && draftTo && !turn.draft && (
              <button
                type="button"
                data-demo-target={last ? "chat-draft-btn" : undefined}
                className={BTN_PRIMARY}
                onClick={() => dispatch({ type: "draft", turnId: turn.id })}
              >
                <PenLine className="size-3.5" aria-hidden="true" />
                Draft a message to {firstName(draftTo)}
              </button>
            )}

            {turn.draft && draftTo && turn.draft.state !== "discarded" && (
              <div data-demo-target={last ? "chat-draft-card" : undefined} className="rounded-xl border border-border/70 bg-background p-3">
                <div className="flex items-center gap-2.5">
                  <Avatar person={draftTo} size={36} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{draftTo.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      To {firstName(draftTo)} · via Gmail
                    </p>
                  </div>
                  <span className="rounded-4xl bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">Draft</span>
                  {turn.draft.state === "editing" && (
                    <span className="flex gap-0.5 text-muted-foreground">
                      {[Pencil, Undo2, Copy].map((Icon, k) => (
                        <span key={k} className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted/50">
                          <Icon className="size-3.5" aria-hidden="true" />
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                {turn.draft.state === "editing" ? (
                  <>
                    <div className="mt-2.5 rounded-lg bg-muted/50 p-2">
                      <label className="sr-only" htmlFor={`demo-draft-${turn.id}`}>
                        Draft to {draftTo.name}
                      </label>
                      <textarea
                        id={`demo-draft-${turn.id}`}
                        value={turn.draft.body}
                        onChange={(e) => dispatch({ type: "editDraft", turnId: turn.id, body: e.target.value })}
                        rows={4}
                        className="w-full resize-none bg-transparent text-xs leading-relaxed text-ink focus:outline-none"
                      />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {REWRITES.map((r) => (
                        <button
                          key={r.label}
                          type="button"
                          onClick={() => dispatch({ type: "editDraft", turnId: turn.id, body: r.apply(turn.draft!.body) })}
                          className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-ink"
                        >
                          {r.label}
                        </button>
                      ))}
                    </div>
                    <div className="mt-2.5 flex gap-2">
                      <button type="button" className={cn(BTN_PRIMARY, "rounded-full")} onClick={() => dispatch({ type: "sendDraft", turnId: turn.id })}>
                        <Mail className="size-3.5" aria-hidden="true" />
                        Send email…
                      </button>
                      <button type="button" className={cn(BTN, "rounded-full")} onClick={() => dispatch({ type: "discardDraft", turnId: turn.id })}>
                        Discard
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="mt-2.5 inline-flex items-center gap-1.5 text-xs text-emerald-300">
                    <Check className="size-3.5" aria-hidden="true" />
                    Sent — logged to {firstName(draftTo)}&apos;s timeline
                  </p>
                )}
              </div>
            )}
          </motion.div>
        )}
      </div>
    </div>
  );
}

/** The rail's older chats: made-up, like everything else, and only there to look lived in. */
const HISTORY: { group: string; items: string[] }[] = [
  { group: "Yesterday", items: ["Investors to update this week"] },
  { group: "Previous 7 days", items: ["Who could intro me to Stripe?", "Designers I should stay close to"] },
];

const SUGGESTION_ICONS = [Clock, Users, Sparkles, Handshake];

/** The real chat (`chat-panel.tsx`): a history rail, the thread, then the composer and suggestion pills. */
export function ChatScreen() {
  const { state, dispatch } = useDemo();
  const [draft, setDraft] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);
  const lastAssistant = [...state.chat].reverse().find((t) => t.role === "assistant")?.id;
  const firstQuestion = state.chat.find((t) => t.role === "user");
  const title = firstQuestion && firstQuestion.role === "user" ? firstQuestion.text : "New chat";

  // Keep the newest message in view — inside the thread only, never the page.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const follow = () => (el.scrollTop = el.scrollHeight);
    follow();
    const observer = new MutationObserver(follow);
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [state.chat.length]);

  const submit = (q: string) => {
    if (!q.trim()) return;
    dispatch({ type: "ask", q });
    setDraft("");
  };

  return (
    <div className="flex h-full flex-col gap-4">
      <header>
        <h2 className={cn(DISPLAY, "text-3xl")}>Chat with your network</h2>
        <p className="mt-1 text-muted-foreground">Ask who can help, who to follow up with, or who knows what.</p>
      </header>

      <div className={cn(CARD, "flex min-h-0 flex-1 overflow-hidden")}>
        <aside className="hidden w-48 shrink-0 flex-col border-r border-border/60 p-3 lg:flex" aria-label="Chat history">
          <div className="flex items-center gap-1.5">
            <button type="button" className={cn(BTN, "h-8 flex-1")} onClick={() => dispatch({ type: "newChat" })}>
              <Plus className="size-3.5" aria-hidden="true" />
              New chat
            </button>
            <span className="inline-flex size-8 items-center justify-center rounded-lg border border-border text-muted-foreground">
              <PanelLeftClose className="size-3.5" aria-hidden="true" />
            </span>
          </div>
          <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-hidden text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Today</p>
              <p className={cn("mt-1.5 line-clamp-2 leading-snug", state.chat.length > 0 ? "text-ink" : "text-ink/85")}>{title === "New chat" ? "Who should I follow up with?" : title}</p>
            </div>
            {HISTORY.map((g) => (
              <div key={g.group}>
                <p className="text-xs text-muted-foreground">{g.group}</p>
                {g.items.map((it) => (
                  <p key={it} className="mt-1.5 line-clamp-2 leading-snug text-ink/85">
                    {it}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{title}</p>
              <p className="text-xs text-muted-foreground">Questions about people in your network</p>
            </div>
            <button type="button" className={BTN_GHOST + " border border-border"}>
              <NotebookPen className="size-3.5" aria-hidden="true" />
              Context
            </button>
          </div>

          <div ref={threadRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-5">
            {state.chat.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <p className={cn(DISPLAY, "text-3xl")}>Ask your network</p>
                <p className="max-w-md text-muted-foreground">
                  Who can help, who to follow up with, or who knows what — try a suggestion below.
                </p>
              </div>
            ) : (
              state.chat.map((t) =>
                t.role === "user" ? (
                  <div key={t.id} className="flex justify-end">
                    <p className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground">{t.text}</p>
                  </div>
                ) : (
                  <Answer key={t.id} turn={t} last={t.id === lastAssistant} />
                )
              )
            )}
          </div>

          <div className="space-y-2.5 p-3 pt-0">
            <form
              className="flex items-center gap-2 rounded-full border border-input bg-input/30 py-1.5 pl-3 pr-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                submit(draft);
              }}
            >
              <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <label className="sr-only" htmlFor="demo-chat-input">
                Ask about your network
              </label>
              <input
                id="demo-chat-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Ask about your network…"
                className="min-w-0 flex-1 bg-transparent px-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                autoComplete="off"
              />
              <Mic className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <button type="submit" aria-label="Send" className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-60" disabled={!draft.trim()}>
                <ArrowUp className="size-4" />
              </button>
            </form>
            <div className="flex gap-2 overflow-hidden" aria-label="Suggested questions">
              {CHAT_SUGGESTIONS.map((sg, i) => {
                const Icon = SUGGESTION_ICONS[i % SUGGESTION_ICONS.length]!;
                return (
                  <button
                    key={sg.q}
                    type="button"
                    onClick={() => submit(sg.q)}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border px-3 text-sm text-ink/90 transition-colors hover:border-primary/40"
                  >
                    <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    {sg.q}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
