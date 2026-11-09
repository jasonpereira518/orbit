"use client";

import { Loader2, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "@/lib/toast";

import { addChatMemory, deleteChatMemory, listChatMemories } from "@/actions/chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { friendlyError } from "@/lib/errors";
import { MEMORIES_MAX, MEMORY_MAX_CHARS } from "@/lib/chat-memory-text";

type Memory = { id: string; text: string };

/**
 * "What Orbit remembers": the third box in the chat Context sheet.
 *
 * Everything Orbit keeps in mind across chats is listed here, and anything on the list can be
 * removed. The person can add one directly; the other way one gets here is a "Remember this"
 * card they confirmed in a chat. Like the writing notes above it, this belongs to the
 * account, loads when the sheet first opens, and never travels with a chat request: the
 * server reads it from the signed-in person's own rows.
 */
export function ChatMemoriesField({ active }: { active: boolean }) {
  const id = useId();
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);

  // Reloaded each time the sheet opens: a card confirmed in the chat adds to this list.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    listChatMemories()
      .then((rows) => {
        if (!cancelled) setMemories(rows.map((r) => ({ id: r.id, text: r.text })));
      })
      .catch((err) => {
        if (!cancelled) toast.error(friendlyError(err, "Couldn’t load what Orbit remembers — try again?"));
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  async function add() {
    const value = text.trim();
    if (!value || adding) return;
    setAdding(true);
    try {
      const res = await addChatMemory(value);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setMemories((prev) => [{ id: res.memory.id, text: res.memory.text }, ...(prev ?? [])]);
      setText("");
    } catch (err) {
      toast.error(friendlyError(err, "Couldn’t save that — try again?"));
    } finally {
      setAdding(false);
    }
  }

  async function remove(memory: Memory) {
    // Gone at once, and put back if the server did not remove it.
    setMemories((prev) => (prev ?? []).filter((m) => m.id !== memory.id));
    try {
      const res = await deleteChatMemory(memory.id);
      if (!res.ok) throw new Error("not removed");
    } catch {
      setMemories((prev) => (prev?.some((m) => m.id === memory.id) ? prev : [memory, ...(prev ?? [])]));
      toast.error("Couldn’t remove that — try again?");
    }
  }

  const full = (memories?.length ?? 0) >= MEMORIES_MAX;

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2 border-t border-border/60 p-4">
      <div>
        <h3 id={`${id}-title`} className="text-sm font-medium text-foreground">
          What Orbit remembers
        </h3>
        <p id={`${id}-hint`} className="mt-0.5 text-xs text-muted-foreground">
          Kept in mind in every chat. Nothing is added here unless you add it or confirm it.
        </p>
      </div>

      {memories === null ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading…
        </p>
      ) : memories.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nothing yet. Add something below, or tell Orbit “remember that…” in a chat.
        </p>
      ) : (
        <ul aria-labelledby={`${id}-title`} className="flex flex-col gap-1">
          {memories.map((memory) => (
            <li key={memory.id} className="flex items-start gap-2 rounded-lg bg-muted/50 py-1.5 pl-2.5 pr-1 text-sm">
              <span className="min-w-0 flex-1 break-words">{memory.text}</span>
              <button
                type="button"
                aria-label={`Forget: ${memory.text}`}
                onClick={() => void remove(memory)}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={MEMORY_MAX_CHARS}
          disabled={memories === null || adding || full}
          placeholder={full ? `That’s the limit of ${MEMORIES_MAX} — remove one to add another` : "I’m raising a seed round this quarter"}
          aria-label="Something for Orbit to remember"
          aria-describedby={`${id}-hint`}
          className="h-8 text-sm"
        />
        <Button type="submit" size="sm" variant="outline" disabled={!text.trim() || adding || full}>
          {adding ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : "Remember"}
        </Button>
      </form>
    </section>
  );
}
