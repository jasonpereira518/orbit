"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Check, ChevronDown, CircleDashed, MessageSquarePlus, PenLine, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { firstName, personById } from "../demo-cast";
import { CHAT_SUGGESTIONS, type DemoStep } from "../demo-chat";
import { useDemo } from "../demo-context";
import type { ChatTurn } from "../demo-state";
import { Avatar, BTN, BTN_PRIMARY, CARD, DISPLAY, INPUT, SourceIcon } from "../demo-ui";

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
      <span className="size-1.5 rounded-full bg-[#f2c14e]" />
      <motion.span
        className="absolute inset-0 rounded-full border border-[var(--d-primary)]/60 border-t-transparent"
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
      <span className="absolute left-1/2 top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#f2c14e] shadow-[0_0_14px_#f2c14e]" />
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
      <div className="rounded-xl border border-[var(--d-primary)]/30 bg-[var(--d-muted)]/50">
        <button
          type="button"
          onClick={() => setLiveOpen((v) => !v)}
          aria-expanded={liveOpen}
          className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-[var(--d-ink)]"
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
                {current.detail && <span className="text-[var(--d-dim)]/80"> · {current.detail}</span>}
              </motion.span>
            </AnimatePresence>
          </span>
          <ChevronDown className={cn("size-3.5 shrink-0 text-[var(--d-dim)] transition-transform", liveOpen && "rotate-180")} aria-hidden="true" />
        </button>
        {liveOpen && (
          <div className="flex items-center gap-4 px-3 pb-3">
            <ul className="min-w-0 flex-1 space-y-1.5 pl-[1.4rem]">
              {finished.map((s) => (
                <motion.li
                  key={s.kind}
                  initial={reduced ? false : { opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="relative text-xs leading-snug text-[var(--d-dim)]"
                >
                  <Check className="absolute -left-[1.15rem] top-px size-3.5 text-[var(--d-primary)]" aria-hidden="true" />
                  <span className="text-[var(--d-ink)]/80">{s.label}</span>
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
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--d-border)]/70 px-2.5 py-1 text-xs text-[var(--d-dim)] transition-colors hover:bg-white/5 hover:text-[var(--d-ink)]"
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
            className="mt-2 space-y-2 overflow-hidden border-l border-[var(--d-border)]/70 pl-3"
          >
            {steps.map((s) => (
              <li key={s.kind} className="text-xs text-[var(--d-dim)]">
                <span className="text-[var(--d-ink)]/80">{s.kind === "answer" ? "Wrote the answer" : s.label}</span>
                <span className="text-[var(--d-dim)]/70"> · {formatMs(s.kind === "answer" ? totalMs - steps.reduce((a, x) => a + x.ms, 0) : s.ms)}</span>
                {s.detail && <span className="block text-[var(--d-dim)]/70">{s.detail}</span>}
                {s.kind === "read" && s.refs && (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {s.refs.map((id) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => dispatch({ type: "openProfile", id })}
                        className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-[var(--d-ink)]/80 hover:bg-white/10"
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
      <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--d-primary)]/15 text-[var(--d-primary)]">
        <Sparkles className="size-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 space-y-2.5">
        <Activity steps={steps} at={at} done={done} totalMs={totalMs} />
        {text && (
          <p className="text-sm leading-relaxed text-[var(--d-ink)]">
            <Paragraphs text={text} />
          </p>
        )}

        {finished && (
          <motion.div initial={reduced ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="space-y-2.5">
            <div className="flex flex-wrap gap-1.5">
              {turn.answer.sources.map((s, i) => {
                const p = personById(s.personId)!;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => dispatch({ type: "openProfile", id: p.id })}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[var(--d-border)] bg-[var(--d-muted)] px-2 py-0.5 text-[11px] text-[var(--d-dim)] hover:text-[var(--d-ink)]"
                  >
                    <SourceIcon source={s.source} className="size-3" />
                    {firstName(p)} · {s.label}
                  </button>
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
              <div data-demo-target={last ? "chat-draft-card" : undefined} className="rounded-xl border border-[var(--d-border)] bg-[var(--d-muted)] p-3">
                <p className="text-[11px] text-[var(--d-dim)]">
                  To <span className="text-[var(--d-ink)]">{draftTo.name}</span> · via Gmail
                </p>
                {turn.draft.state === "editing" ? (
                  <>
                    <label className="sr-only" htmlFor={`demo-draft-${turn.id}`}>
                      Draft to {draftTo.name}
                    </label>
                    <textarea
                      id={`demo-draft-${turn.id}`}
                      value={turn.draft.body}
                      onChange={(e) => dispatch({ type: "editDraft", turnId: turn.id, body: e.target.value })}
                      rows={4}
                      className={cn(INPUT, "mt-2 resize-none text-xs leading-relaxed")}
                    />
                    <div className="mt-2 flex gap-2">
                      <button type="button" className={BTN_PRIMARY} onClick={() => dispatch({ type: "sendDraft", turnId: turn.id })}>
                        Send via Gmail
                      </button>
                      <button type="button" className={BTN} onClick={() => dispatch({ type: "discardDraft", turnId: turn.id })}>
                        Discard
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-emerald-200">
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

export function ChatScreen() {
  const { state, dispatch } = useDemo();
  const [draft, setDraft] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);
  const lastAssistant = [...state.chat].reverse().find((t) => t.role === "assistant")?.id;

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
      <header className="flex items-end justify-between gap-4">
        <div>
          <h2 className={cn(DISPLAY, "text-3xl")}>Chat with your network</h2>
          <p className="mt-1 text-sm text-[var(--d-dim)]">Ask who can help, who to follow up with, or who knows what.</p>
        </div>
        {state.chat.length > 0 && (
          <button type="button" className={BTN} onClick={() => dispatch({ type: "newChat" })}>
            <MessageSquarePlus className="size-3.5" aria-hidden="true" />
            New chat
          </button>
        )}
      </header>

      <div className={cn(CARD, "flex min-h-0 flex-1 flex-col")}>
        <div ref={threadRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-5">
          {state.chat.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-5">
              <p className={cn(DISPLAY, "text-2xl")}>Ask your network</p>
              <div className="grid w-full max-w-xl grid-cols-2 gap-2">
                {CHAT_SUGGESTIONS.map((s) => (
                  <button
                    key={s.q}
                    type="button"
                    onClick={() => submit(s.q)}
                    className="rounded-xl border border-[var(--d-border)]/70 bg-[var(--d-muted)] px-3 py-2.5 text-left transition-colors hover:border-[var(--d-primary)]/40"
                  >
                    <p className="text-xs font-medium text-[var(--d-ink)]">{s.q}</p>
                    <p className="mt-0.5 text-[11px] text-[var(--d-dim)]">{s.why}</p>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            state.chat.map((t) =>
              t.role === "user" ? (
                <div key={t.id} className="flex justify-end">
                  <p className="max-w-[75%] rounded-2xl rounded-br-md bg-[var(--d-primary)]/15 px-3.5 py-2 text-sm text-[var(--d-ink)]">{t.text}</p>
                </div>
              ) : (
                <Answer key={t.id} turn={t} last={t.id === lastAssistant} />
              )
            )
          )}
        </div>

        <form
          className="flex items-center gap-2 border-t border-[var(--d-border)]/60 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit(draft);
          }}
        >
          <label className="sr-only" htmlFor="demo-chat-input">
            Ask about your network
          </label>
          <input
            id="demo-chat-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask about your network…"
            className={INPUT}
            autoComplete="off"
          />
          <button type="submit" aria-label="Send" className={cn(BTN_PRIMARY, "size-9 shrink-0 rounded-full p-0")} disabled={!draft.trim()}>
            <ArrowUp className="size-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
