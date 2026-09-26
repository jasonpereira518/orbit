"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEMO_PEOPLE, firstName, personById, type TimelineType } from "./demo-cast";
import { useDemo } from "./demo-context";
import { Avatar, BTN, BTN_PRIMARY, INPUT, TIMELINE_TYPES, TypeIcon } from "./demo-ui";

function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    // preventScroll: focusing must never scroll the waitlist page itself.
    ref.current?.focus({ preventScroll: true });
  }, []);
  return ref;
}

function Scrim({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const { reduced } = useDemo();
  return (
    <motion.div
      className="absolute inset-0 z-30 flex items-start justify-center bg-[#04070f]/60 pt-16 backdrop-blur-[2px]"
      initial={reduced ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={reduced ? undefined : { opacity: 0 }}
      transition={{ duration: 0.15 }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {children}
    </motion.div>
  );
}

export function SearchPalette() {
  const { dispatch } = useDemo();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useFocusOnMount<HTMLInputElement>();
  const needle = q.trim().toLowerCase();
  const results = DEMO_PEOPLE.filter((p) => !needle || [p.name, p.company, p.title, ...p.tags].some((f) => f.toLowerCase().includes(needle))).slice(0, 7);
  const close = () => dispatch({ type: "overlay", overlay: null });
  const open = (id: string) => dispatch({ type: "openProfile", id });

  return (
    <Scrim onClose={close}>
      <div role="dialog" aria-label="Search your network" className="w-[420px] overflow-hidden rounded-2xl border border-[var(--d-border)] bg-[var(--d-card)] shadow-2xl">
        <div className="flex items-center gap-2 border-b border-[var(--d-border)]/70 px-3">
          <Search className="size-4 text-[var(--d-dim)]" aria-hidden="true" />
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(results.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter" && results[active]) {
                open(results[active]!.id);
              }
            }}
            placeholder="Search people, companies, tags…"
            aria-label="Search people, companies, tags"
            className="w-full bg-transparent py-3 text-sm text-[var(--d-ink)] placeholder:text-[var(--d-dim)]/70 focus:outline-none"
          />
          <kbd className="rounded border border-[var(--d-border)] px-1.5 text-[10px] text-[var(--d-dim)]">esc</kbd>
        </div>
        <ul className="max-h-72 overflow-y-auto p-1.5" role="listbox" aria-label="People">
          {results.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onPointerEnter={() => setActive(i)}
                onClick={() => open(p.id)}
                className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left", i === active && "bg-white/[0.06]")}
              >
                <Avatar person={p} size={26} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-[var(--d-ink)]">{p.name}</span>
                  <span className="block truncate text-[11px] text-[var(--d-dim)]">
                    {p.title} · {p.company}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {results.length === 0 && <li className="px-3 py-6 text-center text-xs text-[var(--d-dim)]">No one matches “{q}”.</li>}
        </ul>
      </div>
    </Scrim>
  );
}

export function LogSheet() {
  const { state, dispatch } = useDemo();
  const [personId, setPersonId] = useState(state.logFor ?? DEMO_PEOPLE[0]!.id);
  const [type, setType] = useState<TimelineType>("Meeting");
  const [note, setNote] = useState("");
  const textarea = useFocusOnMount<HTMLTextAreaElement>();
  const p = personById(personId)!;
  const close = () => dispatch({ type: "overlay", overlay: null });

  return (
    <Scrim onClose={close}>
      <form
        role="dialog"
        aria-label="Log interaction"
        className="w-[440px] rounded-2xl border border-[var(--d-border)] bg-[var(--d-card)] p-4 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          dispatch({ type: "log", id: personId, entryType: type, note: note.trim() || `${type} with ${firstName(p)}` });
        }}
      >
        <p className="font-[family-name:var(--font-display)] text-lg text-[var(--d-ink)]">Log interaction</p>
        <label className="mt-3 block text-[11px] font-medium text-[var(--d-dim)]" htmlFor="demo-log-person">
          With
        </label>
        <select
          id="demo-log-person"
          value={personId}
          onChange={(e) => setPersonId(e.target.value)}
          className={cn(INPUT, "mt-1 py-1.5")}
        >
          {DEMO_PEOPLE.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name} — {x.company}
            </option>
          ))}
        </select>
        <p className="mt-3 text-[11px] font-medium text-[var(--d-dim)]">What happened</p>
        <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-label="Interaction type">
          {TIMELINE_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={type === t}
              onClick={() => setType(t)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-[11px]",
                type === t ? "border-[var(--d-primary)]/60 text-[var(--d-ink)]" : "border-[var(--d-border)] text-[var(--d-dim)]"
              )}
            >
              <span className="scale-75">
                <TypeIcon type={t} />
              </span>
              {t}
            </button>
          ))}
        </div>
        <label className="mt-3 block text-[11px] font-medium text-[var(--d-dim)]" htmlFor="demo-log-note">
          Notes
        </label>
        <textarea
          id="demo-log-note"
          ref={textarea}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder={`What did you and ${firstName(p)} talk about?`}
          className={cn(INPUT, "mt-1 resize-none text-xs")}
        />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className={BTN} onClick={close}>
            Cancel
          </button>
          <button type="submit" className={BTN_PRIMARY}>
            Save to timeline
          </button>
        </div>
      </form>
    </Scrim>
  );
}
