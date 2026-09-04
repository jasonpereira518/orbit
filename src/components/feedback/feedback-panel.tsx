"use client";

import { Camera, Loader2, X } from "lucide-react";
import { useTheme } from "next-themes";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { submitFeedback } from "@/actions/feedback";
import type { DraftShot } from "@/components/feedback/feedback-widget";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  AREA_OPTIONS,
  FEEDBACK_CATEGORIES,
  MAX_FEEDBACK_TEXT,
  MAX_SCREENSHOTS,
  featureAreaForPath,
  readClientContext,
  type FeedbackArea,
  type FeedbackCategory,
} from "@/lib/feedback-report";
import { blobToDataUrl } from "@/lib/screenshot-capture";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  bug: "Something's broken",
  idea: "I have an idea",
  confusing: "This confused me",
  praise: "This worked well",
};

export function FeedbackPanel({
  message,
  onMessageChange,
  shots,
  canCapture,
  onAddScreenshot,
  onRemoveShot,
  onEditShot,
  onClose,
  onSent,
}: {
  message: string;
  onMessageChange: (value: string) => void;
  shots: DraftShot[];
  canCapture: boolean;
  onAddScreenshot: () => void;
  onRemoveShot: (id: string) => void;
  onEditShot: (id: string) => void;
  onClose: () => void;
  onSent: () => void;
}) {
  const pathname = usePathname();
  const { resolvedTheme } = useTheme();
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [area, setArea] = useState<FeedbackArea>(() => featureAreaForPath(pathname ?? "/"));
  const [sending, setSending] = useState(false);

  const remaining = MAX_FEEDBACK_TEXT - message.length;
  const canSend = message.trim().length > 0 && !sending;

  const usedShots = useMemo(() => shots.length, [shots]);

  async function send() {
    if (!canSend) return;
    setSending(true);
    try {
      // Encoded to base64 here, once, rather than held that way — base64 costs 4/3 of the
      // bytes in the JS heap for as long as the panel is open, for no benefit.
      const screenshots = await Promise.all(
        shots.map(async (shot) => ({
          dataUrl: await blobToDataUrl(shot.blob),
          note: shot.note || undefined,
          width: shot.width,
          height: shot.height,
        }))
      );

      const client = readClientContext(resolvedTheme);
      const result = await submitFeedback({
        text: message,
        area,
        category,
        path: client.path,
        viewport: client.viewport,
        devicePixelRatio: client.devicePixelRatio,
        theme: client.theme,
        timeZone: client.timeZone,
        screenshots,
      });

      if (!result.ok) {
        // The panel stays open and nothing is cleared: whatever went wrong, the words are
        // still the person's and they should not have to retype them.
        toast.error(result.message);
        return;
      }
      toast.success("Thanks — that's on its way.");
      onSent();
    } catch {
      toast.error("Couldn't send that. Try again in a moment.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (open) return;
        if (message.trim().length > 0 && !window.confirm("Discard your feedback?")) return;
        onClose();
      }}
    >
      <SheetContent
        side="floating"
        // `SheetContent` carries no radius of its own — the edge-anchored sides are meant
        // to sit flush. The floating side is inset on all four edges, so it needs one; the
        // notifications window gets the same shape from `.liquid-glass-panel`.
        className="gap-5 overflow-y-auto rounded-2xl p-6"
      >
        <SheetHeader className="p-0">
          <SheetTitle className="font-[family-name:var(--font-display)] text-lg">
            Tell us what happened
          </SheetTitle>
          <SheetDescription>
            It goes straight to whoever runs Orbit, with the page you&apos;re on attached.
          </SheetDescription>
        </SheetHeader>

        {/* A segmented row rather than a Select: four options, and a popup inside a
            floating sheet is a stacking-context fight nobody wins. */}
        <div className="flex flex-wrap gap-2" role="group" aria-label="Kind of feedback">
          {FEEDBACK_CATEGORIES.map((value) => (
            <Button
              key={value}
              type="button"
              size="xs"
              variant={category === value ? "default" : "outline"}
              aria-pressed={category === value}
              onClick={() => setCategory(value)}
            >
              {CATEGORY_LABELS[value]}
            </Button>
          ))}
        </div>

        <div className="grid gap-1.5">
          <label htmlFor="feedback-area" className="text-xs font-medium text-muted-foreground">
            Which part of Orbit?
          </label>
          <select
            id="feedback-area"
            value={area}
            onChange={(e) => setArea(e.target.value as FeedbackArea)}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {AREA_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Textarea
            autoFocus
            rows={5}
            value={message}
            maxLength={MAX_FEEDBACK_TEXT}
            placeholder="What were you trying to do, and what happened instead?"
            onChange={(e) => onMessageChange(e.target.value)}
          />
          {remaining < 400 && (
            <p className="text-right text-xs text-muted-foreground">{remaining} left</p>
          )}
        </div>

        <div className="grid gap-2">
          {/* The primary way to attach one: full width, its own label, and an explanation of
              what the gesture is. It was a 72px dashed tile next to the thumbnails and read
              as an afterthought — which is backwards, since a screenshot is the most useful
              thing in the whole submission. */}
          {canCapture && usedShots < MAX_SCREENSHOTS && (
            <Button
              type="button"
              variant="outline"
              // `whitespace-normal` undoes `buttonVariants`' nowrap, which would otherwise
              // clip the second line against the sheet's 24rem max width.
              className="h-auto w-full justify-start gap-3 whitespace-normal border-dashed px-4 py-3 text-left"
              onClick={onAddScreenshot}
            >
              <Camera className="size-5 shrink-0" />
              <span className="grid gap-0.5">
                <span className="text-sm font-medium">Add a screenshot</span>
                <span className="text-xs font-normal leading-snug text-muted-foreground">
                  Drag a box around the problem. It attaches when you let go.
                </span>
              </span>
            </Button>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {shots.map((shot, index) => (
              <div key={shot.id} className="group relative">
                {/* The annotator moved behind this: shots attach on release now, so adding a
                    note is an optional second step rather than a gate on the way in. */}
                <button
                  type="button"
                  onClick={() => onEditShot(shot.id)}
                  aria-label={`Add a note to screenshot ${index + 1}`}
                  className="block rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- a local blob: of
                      the user's own screen, never a remote origin. */}
                  <img
                    src={shot.previewUrl}
                    alt={shot.note || `Screenshot ${index + 1}`}
                    className="h-16 w-24 rounded-md border border-border object-cover"
                  />
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove screenshot ${index + 1}`}
                  // Focus-within as well as hover: a hover-only control does not exist for
                  // anyone using a keyboard.
                  className="absolute -right-1.5 -top-1.5 size-5 rounded-full bg-background opacity-0 shadow group-hover:opacity-100 group-focus-within:opacity-100"
                  onClick={() => onRemoveShot(shot.id)}
                >
                  <X className="size-3" />
                </Button>
                {shot.note && (
                  <span className="mt-1 block max-w-24 truncate text-[0.65rem] text-muted-foreground">
                    {shot.note}
                  </span>
                )}
              </div>
            ))}
          </div>

          {!canCapture ? (
            // Never render a button that can only fail: getDisplayMedia does not exist on
            // iOS in any browser, and is absent or inert on Android.
            <p className="text-xs text-muted-foreground">
              Screenshots aren&apos;t available in this browser — describe what you saw and
              we&apos;ll find it.
            </p>
          ) : (
            usedShots > 0 && (
              <p className="text-xs text-muted-foreground">
                {usedShots} of {MAX_SCREENSHOTS} attached
                {usedShots < MAX_SCREENSHOTS ? " — tap one to add a note." : "."}
              </p>
            )
          )}
        </div>

        <div className="mt-auto flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              if (message.trim().length > 0 && !window.confirm("Discard your feedback?")) return;
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button type="button" disabled={!canSend} onClick={send} className={cn(sending && "gap-2")}>
            {sending && <Loader2 className="size-3.5 animate-spin" />}
            Send
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
