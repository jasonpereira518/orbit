"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Share2 } from "lucide-react";
import { motion } from "motion/react";
import { buildShareUrl, shareText, type InterestTicket } from "@/lib/interest-list";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

const PILL =
  "inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-[#e8f3f1]/[0.14] px-3 text-sm text-[#e8f3f1] transition-colors hover:border-[#e8f3f1]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f2c14e]/60";

/**
 * The ticket's share tools: the link in a read-only field, Copy, X, LinkedIn, and — only
 * after mount, only where the browser has one — the native share sheet.
 *
 * Share intents open in a new tab; the text is prewritten (`shareText`) and the URL is the
 * `?ref=` link, so whoever follows it lands on the invited state and the referral counts.
 */
export function ShareRow({ ticket, appUrl, play }: { ticket: InterestTicket; appUrl: string; play: boolean }) {
  const reduced = usePrefersReducedMotion();
  const url = buildShareUrl(appUrl, ticket.shareToken);
  const text = shareText(ticket);
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      inputRef.current?.select();
      document.execCommand("copy");
    }
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  }

  async function nativeShare() {
    try {
      await navigator.share({ title: "Orbit interest list", text, url });
    } catch {
      // Dismissed. Nothing to do.
    }
  }

  const x = `https://twitter.com/intent/tweet?${new URLSearchParams({ text, url })}`;
  const linkedin = `https://www.linkedin.com/sharing/share-offsite/?${new URLSearchParams({ url })}`;

  const enter = (i: number) =>
    play && !reduced
      ? { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: DUR.base, ease: EASE_HOUSE, delay: 1.35 + i * 0.05 } }
      : { initial: false as const, animate: { opacity: 1, y: 0 } };

  return (
    <div className="mt-4">
      <motion.div {...enter(0)} className="flex gap-2">
        <label htmlFor="interest-share-link" className="sr-only">
          Your share link
        </label>
        <input
          id="interest-share-link"
          ref={inputRef}
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className={cn(
            "h-10 min-w-0 flex-1 rounded-lg border bg-[#05070f]/50 px-3 font-mono text-xs text-[#9aada8] transition-colors focus:outline-none",
            copied ? "border-[#f2c14e]/70" : "border-[#e8f3f1]/[0.14]"
          )}
        />
        <button type="button" onClick={copy} className={cn(PILL, "bg-[#e8f3f1] text-[#0f3d3e] hover:border-transparent hover:bg-white")} aria-live="polite">
          {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </motion.div>
      <motion.div {...enter(1)} className="mt-2 flex flex-wrap gap-2">
        <a href={x} target="_blank" rel="noopener noreferrer" className={PILL}>
          Share on X
        </a>
        <a href={linkedin} target="_blank" rel="noopener noreferrer" className={PILL}>
          LinkedIn
        </a>
        {canShare ? (
          <button type="button" onClick={nativeShare} className={PILL}>
            <Share2 className="size-4" aria-hidden="true" />
            Share…
          </button>
        ) : null}
      </motion.div>
    </div>
  );
}
