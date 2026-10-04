"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { searchRecipientsAction } from "@/actions/email-compose";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import type { ComposeRecipient } from "@/lib/email/compose";
import { cn } from "@/lib/utils";

/** Shape only, for flagging a chip — the server's `normalizeRecipients` is the authority. */
const EMAIL_SHAPE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/**
 * An address list as chips. Enter, comma, semicolon, Tab or blur turns what was typed into a
 * chip; Backspace on an empty input removes the last one; pasting a list splits it. Suggestions
 * come from the user's contacts (every address a person has), or from `suggestions` — the
 * contact's own addresses — when nothing is typed.
 */
export function RecipientField({
  id,
  label,
  value,
  onChange,
  suggestions = [],
  autoFocus,
}: {
  id: string;
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  suggestions?: ComposeRecipient[];
  autoFocus?: boolean;
}) {
  const listId = useId();
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [results, setResults] = useState<ComposeRecipient[]>([]);
  const [active, setActive] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const term = text.trim();
    const mine = ++seq.current;
    if (!term) return;
    const t = setTimeout(() => {
      searchRecipientsAction(term)
        .then((r) => {
          if (mine === seq.current) setResults(r);
        })
        .catch(() => {
          if (mine === seq.current) setResults([]);
        });
    }, 140);
    return () => clearTimeout(t);
  }, [text]);

  const options = (text.trim() ? results : suggestions).filter((r) => !value.includes(r.email));
  const open = focused && options.length > 0;

  function add(raw: string) {
    const parts = raw
      .split(/[,;\s]+/)
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    const next = [...value];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    onChange(next);
    setText("");
    setResults([]);
    setActive(0);
  }

  return (
    <div className="flex items-start gap-2 border-b border-border/60 py-1.5">
      <label htmlFor={id} className="w-10 shrink-0 pt-1 text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <div className="relative flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {value.map((email) => {
          const bad = !EMAIL_SHAPE.test(email);
          return (
            <span
              key={email}
              className={cn(
                "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                bad ? "border-destructive/60 text-destructive" : "border-border bg-muted/50"
              )}
              title={bad ? "This doesn’t look like an email address" : undefined}
            >
              <span className="truncate">{email}</span>
              <button
                type="button"
                aria-label={`Remove ${email}`}
                className="rounded-full p-0.5 hover:bg-foreground/10"
                onClick={() => onChange(value.filter((v) => v !== email))}
              >
                <X className="size-3" />
              </button>
            </span>
          );
        })}
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            // Let a click on a suggestion land first.
            setTimeout(() => setFocused(false), 120);
            if (text.trim()) add(text);
          }}
          onKeyDown={(e) => {
            if (open && e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, options.length - 1));
              return;
            }
            if (open && e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
              return;
            }
            if (e.key === "Escape" && open) {
              e.stopPropagation();
              setFocused(false);
              return;
            }
            if (e.key === "Enter" || e.key === "," || e.key === ";" || (e.key === "Tab" && text.trim())) {
              if (open && options[active] && e.key !== "," && e.key !== ";") {
                e.preventDefault();
                add(options[active]!.email);
                return;
              }
              if (text.trim()) {
                e.preventDefault();
                add(text);
              }
              return;
            }
            if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            if (/[,;\s]/.test(pasted.trim())) {
              e.preventDefault();
              add(pasted);
            }
          }}
          className="min-w-[8rem] flex-1 bg-transparent py-1 text-sm outline-none"
        />
        {open && (
          <ul
            id={listId}
            role="listbox"
            className="absolute left-0 top-full z-50 mt-1 w-full max-w-sm overflow-hidden rounded-lg border bg-popover p-1 shadow-md"
          >
            {options.map((r, i) => (
              <li
                key={r.email}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(r.email);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                  i === active && "bg-accent"
                )}
              >
                {r.contactId ? (
                  <ContactAvatar
                    contactId={r.contactId}
                    fullName={r.name ?? r.email}
                    profileImageUrl={r.avatarUrl}
                    size="sm"
                    className="size-6"
                  />
                ) : null}
                <span className="min-w-0 truncate">
                  {r.name ? <span className="font-medium">{r.name} </span> : null}
                  <span className="text-muted-foreground">{r.email}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
