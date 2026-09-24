"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Mail, MessageCircle, QrCode, Share2 } from "lucide-react";
import { motion } from "motion/react";
import {
  SHARE_EMAIL_SUBJECT,
  SHARE_TEXT,
  SHARE_TITLE,
  buildShareUrl,
  type InterestTicket,
} from "@/lib/interest-list";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

const PILL =
  "inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-[#e8f3f1]/[0.14] px-3 text-sm text-[#e8f3f1] transition-colors hover:border-[#e8f3f1]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f2c14e]/60";

/**
 * The pass's share tools: the invite link in a read-only field, Copy, X, LinkedIn,
 * WhatsApp, a text message, an email, a QR code for sharing in person, and — only after
 * mount, only where the browser has one — the native share sheet.
 *
 * Share intents open in a new tab; the text is prewritten (`SHARE_TEXT`) and the URL is the
 * `?ref=` link, so whoever follows it lands on the invited state and the referral counts.
 * `pageUrl` is the waitlist page on its own domain (`getWaitlistPageUrl`).
 */
export function ShareRow({ ticket, pageUrl, play }: { ticket: InterestTicket; pageUrl: string; play: boolean }) {
  const reduced = usePrefersReducedMotion();
  const url = buildShareUrl(pageUrl, ticket.shareToken);
  const text = SHARE_TEXT;
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    // "Copied" has to be true. The clipboard API throws where it is denied, and the
    // `execCommand` fallback answers false rather than throwing — so both are checked, and
    // when neither worked the label stays "Copy". The field's text is selected either way,
    // which leaves the manual copy one keystroke off.
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      inputRef.current?.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
    }
    if (!ok) return;
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  }

  async function nativeShare() {
    try {
      await navigator.share({ title: SHARE_TITLE, text, url });
    } catch {
      // Dismissed. Nothing to do.
    }
  }

  async function toggleQr() {
    if (qrOpen) {
      setQrOpen(false);
      return;
    }
    setQrOpen(true);
    if (qr) return;
    try {
      // Loaded on demand: only people sharing in person pay for the encoder.
      const QRCode = (await import("qrcode")).default;
      setQr(
        await QRCode.toString(url, {
          type: "svg",
          errorCorrectionLevel: "M",
          margin: 1,
          color: { dark: "#05070f", light: "#e8f3f1" },
        })
      );
    } catch {
      setQrOpen(false);
    }
  }

  const message = `${text} ${url}`;
  const x = `https://twitter.com/intent/tweet?${new URLSearchParams({ text, url })}`;
  const linkedin = `https://www.linkedin.com/sharing/share-offsite/?${new URLSearchParams({ url })}`;
  const whatsapp = `https://wa.me/?${new URLSearchParams({ text: message })}`;
  // `sms:?&body=` is the one form both iOS and Android read; encodeURIComponent, not
  // URLSearchParams, because Messages shows a `+` literally.
  const sms = `sms:?&body=${encodeURIComponent(message)}`;
  const mail = `mailto:?subject=${encodeURIComponent(SHARE_EMAIL_SUBJECT)}&body=${encodeURIComponent(message)}`;

  const enter = (i: number) =>
    play && !reduced
      ? { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: DUR.base, ease: EASE_HOUSE, delay: 1.35 + i * 0.05 } }
      : { initial: false as const, animate: { opacity: 1, y: 0 } };

  return (
    <div className="mt-4">
      <motion.div {...enter(0)} className="flex gap-2">
        <label htmlFor="interest-share-link" className="sr-only">
          Your invite link
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
        <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={PILL}>
          WhatsApp
        </a>
        <a href={sms} className={PILL}>
          <MessageCircle className="size-4" aria-hidden="true" />
          Text
        </a>
        <a href={mail} className={PILL}>
          <Mail className="size-4" aria-hidden="true" />
          Email
        </a>
        <button
          type="button"
          onClick={toggleQr}
          aria-expanded={qrOpen}
          aria-controls="interest-share-qr"
          className={PILL}
        >
          <QrCode className="size-4" aria-hidden="true" />
          QR code
        </button>
        {canShare ? (
          <button type="button" onClick={nativeShare} className={PILL}>
            <Share2 className="size-4" aria-hidden="true" />
            Share…
          </button>
        ) : null}
      </motion.div>
      {qrOpen ? (
        <div id="interest-share-qr" className="mt-3 flex items-center gap-4">
          {qr ? (
            <span
              role="img"
              aria-label="QR code for your invite link"
              className="block size-32 shrink-0 overflow-hidden rounded-lg [&>svg]:size-full"
              // The encoder's own SVG, built from our URL — no user HTML reaches it.
              dangerouslySetInnerHTML={{ __html: qr }}
            />
          ) : (
            <span className="block size-32 shrink-0 rounded-lg bg-[#e8f3f1]/[0.08]" aria-hidden="true" />
          )}
          <p className="text-xs leading-[1.6] text-[#9aada8]">
            Meeting someone in person? Let them scan this — it opens your invite link.
          </p>
        </div>
      ) : null}
    </div>
  );
}
