"use client";

import { useState, type ReactNode } from "react";
import {
  toast as sonnerToast,
  type ExternalToast,
} from "sonner";
import { cn } from "@/lib/utils";
import { ExpandableText } from "@/components/ui/expandable-text";
import { keepNotification } from "@/lib/kept-notifications";

const EXPAND_THRESHOLD = 100;

function ExpandableToastMessage({
  message,
  tone = "default",
}: {
  message: string;
  tone?: "default" | "error";
}) {
  const [expanded, setExpanded] = useState(false);
  const needsExpand =
    message.length > EXPAND_THRESHOLD || message.includes("\n");

  if (!needsExpand) {
    return (
      <span className="whitespace-pre-wrap break-words">{message}</span>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span
        className={cn(
          "whitespace-pre-wrap break-words",
          !expanded && "line-clamp-2"
        )}
      >
        {message}
      </span>
      <button
        type="button"
        className={cn(
          "self-start text-xs font-medium underline-offset-2 hover:underline",
          tone === "error" ? "text-destructive" : "text-primary"
        )}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setExpanded((v) => !v);
        }}
      >
        {expanded ? "See less" : "See more"}
      </button>
    </div>
  );
}

function maybeExpandable(
  message: string | ReactNode,
  tone: "default" | "error" = "default"
) {
  if (typeof message !== "string") return message;
  if (message.length <= EXPAND_THRESHOLD && !message.includes("\n")) {
    return message;
  }
  return <ExpandableToastMessage message={message} tone={tone} />;
}

/**
 * Give a long description a "See more" instead of just cutting it off.
 *
 * The title has had an expander for a while; the description was clamped at
 * three lines with an ellipsis and no way past it, so anything a caller put
 * beyond that was simply unreadable. `ExpandableText` measures rather than
 * counting characters, so the control only appears when the text genuinely
 * overflows — a three-line description shows no button at all.
 *
 * Expanded it is still capped: the content column in `ui/sonner.tsx` has a
 * max height and scrolls, which is what stops a stack trace turning the toast
 * into a full-height panel. The clamp lives here rather than on
 * `classNames.description`, because a clamp on the wrapper would keep cutting
 * at three lines no matter what this expanded to.
 */
function maybeExpandableDescription(
  data?: ExternalToast
): ExternalToast | undefined {
  if (!data || typeof data.description !== "string") return data;
  return {
    ...data,
    description: (
      <ExpandableText
        text={data.description}
        lines={3}
        // `classNames.description` sizes the wrapper; this matches it on the
        // paragraph, which `ExpandableText` otherwise renders at `text-sm`.
        className="text-[13px] leading-5 text-muted-foreground"
        buttonClassName="orbit-toast-expander"
      />
    ),
  };
}

/**
 * `keep: false` opts a toast out of the notification center.
 *
 * For toasts that are their own point — the variant previews behind Settings'
 * "Send test notification" — where being filed under Missed would be reporting
 * a failure that never happened. Everything else keeps the default, so a real
 * error is never dropped by forgetting a flag.
 */
export type OrbitToastData = ExternalToast & { keep?: boolean };

/** Sonner never sees `keep` — it is ours, and it is not a toast option. */
function stripKeep(data?: OrbitToastData): ExternalToast | undefined {
  if (!data) return data;
  const { keep: _keep, ...rest } = data;
  return rest;
}

/**
 * Toasts worth keeping after they leave the screen: anything that failed, and
 * anything that offered an action. See `lib/kept-notifications.ts` for why those
 * two and nothing else.
 *
 * Recorded when the toast goes away rather than when it appears, so the panel
 * holds what you did NOT deal with. Both exits count: a timeout is the case the
 * user asked for, and a deliberate dismiss still deserves the safety net,
 * because a swipe is easy to do by accident and an error has nowhere else to go.
 */
function withKeep(
  tone: "error" | "action",
  message: string | ReactNode,
  data: ExternalToast | undefined,
  fire: (data: ExternalToast) => string | number
): string | number {
  // Only a plain string can be stored. Every current call site passes one; a
  // ReactNode message would have to be re-rendered from data we do not have.
  const title = typeof message === "string" ? message : null;
  const action =
    data?.action && typeof data.action === "object" && "label" in data.action
      ? (data.action as { label: ReactNode; onClick: () => void })
      : null;

  if (!title) return fire({ ...stripKeep(data) });

  // The id comes from the toast sonner hands back to the callback rather than
  // from the `fire()` return value, so nothing has to be declared before it is
  // assigned just to be visible in here.
  const record = (toastId: string | number) => {
    keepNotification({
      id: String(toastId),
      tone,
      title,
      description:
        typeof data?.description === "string" ? data.description : undefined,
      actionLabel:
        action && typeof action.label === "string" ? action.label : undefined,
      onAction: action ? () => action.onClick() : undefined,
    });
  };

  return fire({
    ...stripKeep(data),
    // `orbit-toast-kept` is what makes the exit fly toward the bell instead of
    // sliding straight out — see globals.css.
    className: [data?.className, "orbit-toast-kept"].filter(Boolean).join(" "),
    // Chained, never replaced: a caller's own handler has to keep working.
    onAutoClose: (t) => {
      record(t.id);
      data?.onAutoClose?.(t);
    },
    onDismiss: (t) => {
      record(t.id);
      data?.onDismiss?.(t);
    },
  });
}

/** Drop-in toast helpers with See more for long messages (especially errors). */
export const toast = {
  ...sonnerToast,
  error(message: string | ReactNode, data?: OrbitToastData) {
    if (data?.keep === false) {
      return sonnerToast.error(
        maybeExpandable(message, "error"),
        maybeExpandableDescription({
          ...stripKeep(data),
          duration: data.duration ?? 10_000,
        })
      );
    }
    return withKeep("error", message, data, (d) =>
      sonnerToast.error(
        maybeExpandable(message, "error"),
        maybeExpandableDescription({ ...d, duration: d.duration ?? 10_000 })
      )
    );
  },
  message(message: string | ReactNode, data?: OrbitToastData) {
    if (!data?.action || data.keep === false) {
      return sonnerToast.message(
        maybeExpandable(message),
        maybeExpandableDescription(stripKeep(data))
      );
    }
    return withKeep("action", message, data, (d) =>
      sonnerToast.message(maybeExpandable(message), maybeExpandableDescription(d))
    );
  },
  warning(message: string | ReactNode, data?: OrbitToastData) {
    if (!data?.action || data.keep === false) {
      return sonnerToast.warning(
        maybeExpandable(message),
        maybeExpandableDescription(stripKeep(data))
      );
    }
    return withKeep("action", message, data, (d) =>
      sonnerToast.warning(maybeExpandable(message), maybeExpandableDescription(d))
    );
  },
  success(message: string | ReactNode, data?: OrbitToastData) {
    if (!data?.action || data.keep === false) {
      return sonnerToast.success(
        maybeExpandable(message),
        maybeExpandableDescription(stripKeep(data))
      );
    }
    return withKeep("action", message, data, (d) =>
      sonnerToast.success(maybeExpandable(message), maybeExpandableDescription(d))
    );
  },
  info(message: string | ReactNode, data?: OrbitToastData) {
    if (!data?.action || data.keep === false) {
      return sonnerToast.info(
        maybeExpandable(message),
        maybeExpandableDescription(stripKeep(data))
      );
    }
    return withKeep("action", message, data, (d) =>
      sonnerToast.info(maybeExpandable(message), maybeExpandableDescription(d))
    );
  },
};
