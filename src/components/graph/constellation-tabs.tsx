"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2, MoreHorizontal, Plus } from "lucide-react";
import {
  createConstellation,
  deleteConstellation,
  renameConstellation,
} from "@/actions/custom-constellations";
// Type only: the module behind it reaches `@/db`, which must not enter the client bundle.
import type { ConstellationTab } from "@/lib/custom-constellations";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const PROMPT_MAX = 300;
const NAME_MAX = 60;

// Same copy the server throws at the cap (FREE_CAP_COPY), repeated because that module is server-only.
const CAP_COPY = "Free plan keeps up to 3 constellations. Upgrade for unlimited, or delete one to make room.";

/** Pill shared by every tab. The focus ring is inset: the strip scrolls, and an outer ring would be clipped by it. */
const PILL =
  "inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40";
const PILL_ON = "border-primary/40 bg-primary/15 text-foreground";
const PILL_OFF = "border-border bg-muted text-muted-foreground hover:text-foreground dark:bg-input/30";

/**
 * The star chart's sky picker: Everyone, then each saved constellation in the order it was made,
 * then "+ New". The selection lives in the URL (`?c=<id>`), so tabs are links and back/forward work.
 */
export function ConstellationTabs({
  tabs,
  activeId,
  canCreate,
  className,
}: {
  tabs: ConstellationTab[];
  activeId: string | null;
  canCreate: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const active = tabs.find((t) => t.id === activeId) ?? null;
  const nav = useRef<HTMLElement>(null);
  // A deep link or a back-step can land on a tab that is scrolled out of the strip.
  useEffect(() => {
    nav.current
      ?.querySelector<HTMLElement>("a[aria-current=page]")
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeId]);
  // The field unmounts with focus inside it, which would drop it on <body>; hand it back to the tab.
  const refocusActive = () =>
    requestAnimationFrame(() => nav.current?.querySelector<HTMLElement>("a[aria-current=page]")?.focus());

  return (
    <nav ref={nav} aria-label="Constellations" className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {/* The scroller holds only the sky tabs. "+ New" stays outside it so a phone never has to scroll to find it. */}
      <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Link
          href="/graph"
          aria-current={active ? undefined : "page"}
          className={cn(PILL, active ? PILL_OFF : PILL_ON)}
        >
          Everyone
        </Link>
        {tabs.map((t) =>
          t.id === active?.id && renaming ? (
            <RenameField
              key={t.id}
              tab={t}
              onDone={(refocus) => {
                setRenaming(false);
                if (refocus) refocusActive();
              }}
              onSaved={() => {
                setRenaming(false);
                router.refresh();
                refocusActive();
              }}
            />
          ) : (
            <Link
              key={t.id}
              href={`/graph?c=${t.id}`}
              aria-current={t.id === active?.id ? "page" : undefined}
              title={t.name}
              className={cn(PILL, "max-w-[14rem]", t.id === active?.id ? PILL_ON : PILL_OFF)}
            >
              <span className="truncate">{t.name}</span>
              <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">{t.memberCount}</span>
            </Link>
          )
        )}
      </div>
      {active && !renaming && (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Options for ${active.name}`}
            className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "shrink-0 rounded-full")}
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          {/* finalFocus off: the rename field takes focus itself, and returning it to the trigger would blur (cancel) it. */}
          <DropdownMenuContent align="end" className="w-36" finalFocus={false}>
            <DropdownMenuItem onClick={() => setRenaming(true)}>Rename</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <NewConstellation canCreate={canCreate} />
      {active && (
        <DeleteDialog
          tab={active}
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          onDeleted={() => {
            setConfirmDelete(false);
            router.push("/graph");
          }}
        />
      )}
    </nav>
  );
}

function NewConstellation({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const asked = prompt.trim();
    if (!asked || pending) return;
    setPending(true);
    try {
      const { id } = await createConstellation(asked);
      setOpen(false);
      setPrompt("");
      router.push(`/graph?c=${id}`);
    } catch (err) {
      toast.error(friendlyError(err, "Couldn’t draw that constellation — try again?"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
      <PopoverTrigger className={cn(PILL, PILL_OFF, "cursor-pointer gap-1 border-dashed")}>
        <Plus className="size-3.5" aria-hidden />
        New
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        {canCreate ? (
          <form onSubmit={submit} className="space-y-2">
            <Input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={PROMPT_MAX}
              placeholder="Who belongs here?"
              aria-label="Who belongs here?"
              disabled={pending}
              autoFocus
            />
            <Button type="submit" size="sm" disabled={pending || !prompt.trim()} aria-busy={pending} className="w-full">
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {pending ? "Drawing…" : "Create"}
            </Button>
          </form>
        ) : (
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">{CAP_COPY}</p>
            <Link href="/pricing" className={cn(buttonVariants({ size: "sm" }), "w-full")}>
              See plans
            </Link>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function RenameField({
  tab,
  onDone,
  onSaved,
}: {
  tab: ConstellationTab;
  /** `refocus` is false when the field closed because focus already went elsewhere. */
  onDone: (refocus: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(tab.name);
  const [pending, setPending] = useState(false);

  async function save() {
    const next = name.trim();
    if (!next || next === tab.name) return onDone(true);
    setPending(true);
    try {
      await renameConstellation(tab.id, next);
      onSaved();
    } catch (err) {
      setPending(false);
      toast.error(friendlyError(err, TOAST_COPY.saveFailed));
    }
  }

  return (
    <Input
      value={name}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void save();
        } else if (e.key === "Escape") onDone(true);
      }}
      onBlur={() => !pending && onDone(false)}
      maxLength={NAME_MAX}
      aria-label="Constellation name"
      // readOnly, not disabled: a disabled field can drop focus, and a blur here means "cancel".
      readOnly={pending}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      className="h-8 w-44 shrink-0 rounded-full px-3"
    />
  );
}

function DeleteDialog({
  tab,
  open,
  onOpenChange,
  onDeleted,
}: {
  tab: ConstellationTab;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const [pending, setPending] = useState(false);

  async function confirm() {
    setPending(true);
    try {
      await deleteConstellation(tab.id);
      onDeleted();
    } catch (err) {
      toast.error(friendlyError(err, TOAST_COPY.deleteFailed));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete “{tab.name}”?</DialogTitle>
          <DialogDescription>
            This removes the constellation only. The people in it stay in your network.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={pending} aria-busy={pending}>
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
