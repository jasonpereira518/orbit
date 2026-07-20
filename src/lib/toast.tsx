"use client";

import { useState, type ReactNode } from "react";
import {
  toast as sonnerToast,
  type ExternalToast,
} from "sonner";
import { cn } from "@/lib/utils";

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

/** Drop-in toast helpers with See more for long messages (especially errors). */
export const toast = {
  ...sonnerToast,
  error(message: string | ReactNode, data?: ExternalToast) {
    return sonnerToast.error(maybeExpandable(message, "error"), {
      ...data,
      duration: data?.duration ?? 10_000,
    });
  },
  message(message: string | ReactNode, data?: ExternalToast) {
    return sonnerToast.message(maybeExpandable(message), data);
  },
  warning(message: string | ReactNode, data?: ExternalToast) {
    return sonnerToast.warning(maybeExpandable(message), data);
  },
  success(message: string | ReactNode, data?: ExternalToast) {
    return sonnerToast.success(maybeExpandable(message), data);
  },
  info(message: string | ReactNode, data?: ExternalToast) {
    return sonnerToast.info(maybeExpandable(message), data);
  },
};
