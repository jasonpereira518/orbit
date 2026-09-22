"use client";

import { Check, Copy, Loader2, Pencil, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { refineChatDraft } from "@/actions/chat";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { DRAFT_MAX_CHARS } from "@/lib/chat-draft";
import type { RefineKind } from "@/lib/chat-refine";
import { cn } from "@/lib/utils";

const CHIPS: ReadonlyArray<{ kind: RefineKind; label: string; done: string }> = [
  { kind: "shorter", label: "Shorter", done: "Made it shorter" },
  { kind: "warmer", label: "Warmer", done: "Made it warmer" },
  { kind: "direct", label: "More direct", done: "Made it more direct" },
  { kind: "formal", label: "More formal", done: "Made it more formal" },
];

/**
 * The draft on a recommendation card, as something you can work on rather than just read:
 * click it (or the pencil) to edit, one-tap rewrites to nudge it, Undo to step back, Copy.
 *
 * What is edited here is CLIENT STATE and is lost on reload, on purpose: the stored message is
 * the model's original, and the moment a draft becomes a record is when it is sent, not while
 * it is being polished. `actions` is where that step plugs in, handed the text as it stands.
 *
 * The rewrite chips send the draft and nothing else — see `chat-refine.ts` for what the server
 * does with it and why the instruction is a fixed enum rather than something typed.
 */
export function DraftEditor({
  initial,
  name,
  actions,
}: {
  initial: string;
  /** Who the message is for, for the field's accessible name. */
  name: string;
  /** Extra controls in the toolbar (Send), given the draft as it currently reads. */
  actions?: (text: string) => ReactNode;
}) {
  const [text, setText] = useState(initial);
  /** Earlier versions, newest last. Undo pops it. */
  const [stack, setStack] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<RefineKind | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState("");
  const editStartRef = useRef(initial);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  // Focus with the caret at the end when editing starts, so typing continues the message.
  useEffect(() => {
    if (!editing) return;
    const el = fieldRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const startEditing = useCallback(() => {
    editStartRef.current = text;
    setEditing(true);
  }, [text]);

  const finishEditing = useCallback(() => {
    setEditing(false);
    // One undo step per editing session, not per keystroke.
    const before = editStartRef.current;
    if (text !== before) setStack((s) => [...s, before]);
  }, [text]);

  async function refine(kind: RefineKind, done: string) {
    if (busy || !text.trim()) return;
    setBusy(kind);
    setStatus("");
    try {
      const res = await refineChatDraft(text, kind);
      if (res.ok) {
        setStack((s) => [...s, text]);
        setText(res.draft);
        setStatus(done);
      } else {
        toast.error(res.error);
      }
    } catch {
      toast.error("Couldn’t rewrite that — your draft is unchanged");
    } finally {
      setBusy(null);
    }
  }

  function undo() {
    const previous = stack[stack.length - 1];
    if (previous === undefined) return;
    setStack(stack.slice(0, -1));
    setText(previous);
    setStatus("Undid the last change");
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Couldn’t copy that — try selecting the text instead");
    }
  }

  return (
    <div className="mt-2 rounded-lg bg-muted/50 p-2 text-xs">
      <div className="mb-1 flex items-center justify-between gap-2">
        <Badge variant="secondary" className="text-[10px]">
          Draft
        </Badge>
        <div className="flex items-center gap-0.5">
          <ToolButton label="Edit draft" onClick={startEditing} disabled={editing || busy !== null}>
            <Pencil className="size-3.5" />
          </ToolButton>
          <ToolButton label="Undo last change" onClick={undo} disabled={stack.length === 0 || busy !== null}>
            <Undo2 className="size-3.5" />
          </ToolButton>
          <ToolButton label={copied ? "Copied" : "Copy draft"} onClick={copy}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </ToolButton>
        </div>
      </div>

      {editing ? (
        <Textarea
          ref={fieldRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={finishEditing}
          onKeyDown={(e) => {
            // Escape leaves the field with the edit kept; it must not also close a sheet.
            if (e.key === "Escape") {
              e.stopPropagation();
              e.currentTarget.blur();
            }
          }}
          maxLength={DRAFT_MAX_CHARS}
          aria-label={`Draft message to ${name}`}
          className="min-h-20 bg-background text-xs md:text-xs"
        />
      ) : (
        <p
          role="button"
          tabIndex={0}
          aria-label={`Draft message to ${name}. Activate to edit.`}
          onClick={startEditing}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              startEditing();
            }
          }}
          className={cn(
            "cursor-text whitespace-pre-wrap rounded text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50",
            busy && "opacity-60",
          )}
        >
          {text}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1" role="group" aria-label="Rewrite the draft">
        {CHIPS.map((chip) => (
          <button
            key={chip.kind}
            type="button"
            onClick={() => refine(chip.kind, chip.done)}
            disabled={busy !== null || editing}
            aria-busy={busy === chip.kind}
            className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === chip.kind && <Loader2 className="size-3 animate-spin" aria-hidden />}
            {chip.label}
          </button>
        ))}
      </div>

      {actions && <div className="mt-2">{actions(text)}</div>}

      {/* Announced, not shown: the text changing under a screen reader says nothing by itself. */}
      <span className="sr-only" role="status" aria-live="polite">
        {status}
      </span>
    </div>
  );
}

function ToolButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
