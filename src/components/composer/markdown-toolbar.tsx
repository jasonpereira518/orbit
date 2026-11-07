"use client";

/**
 * The notes box's formatting buttons, and the one way any markdown edit reaches the field.
 *
 * The buttons and the keyboard shortcuts in `MentionComposer` call the same pure transforms
 * (`markdown-shortcuts.ts`) and apply the result the same way, through `applyTextEdit`.
 */

import { Bold, Heading, Italic, List, ListOrdered, type LucideIcon } from "lucide-react";
import type { RefObject } from "react";

import {
  toggleLinePrefix,
  toggleWrap,
  type TextEdit,
} from "@/components/composer/markdown-shortcuts";
import { Button } from "@/components/ui/button";
import { useModKeyLabel } from "@/lib/use-mod-key";
import { cn } from "@/lib/utils";

/**
 * Apply an edit as if it were typed.
 *
 * `execCommand("insertText")` is deprecated but still the only edit that lands on the
 * browser's own undo stack, so Cmd+Z takes back a Cmd+B. It fires a real `input` event, so
 * React's controlled value (and the `@` menu, which listens to it) see an ordinary keystroke.
 * Where it is refused, `setRangeText` plus a synthetic `input` keeps React right at the cost
 * of undo.
 */
export function applyTextEdit(el: HTMLTextAreaElement, edit: TextEdit) {
  el.focus();
  if (edit.from !== edit.to || edit.insert) {
    el.setSelectionRange(edit.from, edit.to);
    const done = edit.insert
      ? document.execCommand("insertText", false, edit.insert)
      : document.execCommand("delete");
    if (!done) {
      el.setRangeText(edit.insert, edit.from, edit.to, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  el.setSelectionRange(edit.selectionStart, edit.selectionEnd);
}

type Action = (value: string, start: number, end: number) => TextEdit | null;

const ACTIONS: { label: string; key?: string; Icon: LucideIcon; run: Action }[] = [
  { label: "Bold", key: "B", Icon: Bold, run: (v, s, e) => toggleWrap(v, s, e, "**") },
  { label: "Italic", key: "I", Icon: Italic, run: (v, s, e) => toggleWrap(v, s, e, "_") },
  { label: "Bulleted list", Icon: List, run: (v, s, e) => toggleLinePrefix(v, s, e, "bullet") },
  { label: "Numbered list", Icon: ListOrdered, run: (v, s, e) => toggleLinePrefix(v, s, e, "numbered") },
  { label: "Heading", Icon: Heading, run: (v, s, e) => toggleLinePrefix(v, s, e, "heading") },
];

export function MarkdownToolbar({
  textareaRef,
  disabled,
  className,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
  className?: string;
}) {
  const mod = useModKeyLabel();
  return (
    <div role="group" aria-label="Formatting" className={cn("flex items-center gap-0.5 pointer-coarse:gap-4", className)}>
      {ACTIONS.map(({ label, key, Icon, run }) => (
        <Button
          key={label}
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          title={key ? `${label} (${mod}+${key})` : label}
          disabled={disabled}
          className="tap-target text-muted-foreground hover:text-foreground"
          // Keep focus — and with it the selection — in the field; a button that took focus
          // would leave nothing selected to format.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const el = textareaRef.current;
            if (!el || el.disabled) return;
            const edit = run(el.value, el.selectionStart, el.selectionEnd);
            if (edit) applyTextEdit(el, edit);
          }}
        >
          <Icon className="size-3.5" aria-hidden />
        </Button>
      ))}
    </div>
  );
}
