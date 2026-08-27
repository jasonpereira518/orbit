"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { ClosenessTierBadge } from "@/components/dashboard/closeness-tier-badge";
import {
  closenessTierChipClass,
} from "@/lib/closeness";
import { companyBrandColor } from "@/lib/company-brand";
import { cn } from "@/lib/utils";

export type ContactPreviewData = {
  id?: string;
  fullName: string;
  firstName: string | null;
  preferredName: string | null;
  title: string | null;
  company: string | null;
  school: string | null;
  location: string | null;
  linkedinUrl: string | null;
  profileImageUrl?: string | null;
  closeness?: number;
  closenessTier?: "inner" | "mid" | "outer";
  /** Short profile blurb shown under meta. */
  summary?: string | null;
  /** Extra line (e.g. related-person reason). */
  detail?: string | null;
};

const OPEN_DELAY_MS = 200;
const CURSOR_OFFSET = 14;
const CARD_WIDTH = 272;
const CARD_EST_HEIGHT = 180;

function clampToViewport(x: number, y: number) {
  if (typeof window === "undefined") return { x, y };
  const maxX = window.innerWidth - CARD_WIDTH - 8;
  const maxY = window.innerHeight - CARD_EST_HEIGHT - 8;
  return {
    x: Math.max(8, Math.min(x, maxX)),
    y: Math.max(8, Math.min(y, maxY)),
  };
}

export function ContactAvatarPreview({
  contact,
  children,
  className,
}: {
  contact: ContactPreviewData;
  children: ReactNode;
  className?: string;
}) {
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const openTimer = useRef<number | null>(null);
  // Cursor-following position lives in refs and is written straight to the
  // card's transform — a React render per pointermove is wasted work.
  const posRef = useRef({ x: 0, y: 0 });
  const cardRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    setMounted(true);
    return () => {
      if (openTimer.current) window.clearTimeout(openTimer.current);
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  function clearOpenTimer() {
    if (openTimer.current) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }

  function applyPos() {
    frameRef.current = null;
    const card = cardRef.current;
    if (card) {
      card.style.transform = `translate3d(${posRef.current.x}px, ${posRef.current.y}px, 0)`;
    }
  }

  function trackPointer(e: PointerEvent) {
    posRef.current = clampToViewport(
      e.clientX + CURSOR_OFFSET,
      e.clientY + CURSOR_OFFSET
    );
    if (frameRef.current == null) {
      frameRef.current = requestAnimationFrame(applyPos);
    }
  }

  function onEnter(e: PointerEvent) {
    trackPointer(e);
    clearOpenTimer();
    openTimer.current = window.setTimeout(() => setVisible(true), OPEN_DELAY_MS);
  }

  function onLeave() {
    clearOpenTimer();
    setVisible(false);
  }

  const displayName = contact.preferredName || contact.fullName;
  const meta = [contact.school, contact.location].filter(Boolean).join(" · ");
  const summary = contact.summary?.trim() || "";
  const detail = contact.detail?.trim() || "";
  const companyColor = companyBrandColor(contact.company);

  return (
    <>
      <span
        className={cn("inline-flex shrink-0", className)}
        onPointerEnter={onEnter}
        onPointerMove={trackPointer}
        onPointerLeave={onLeave}
      >
        {children}
      </span>
      {mounted &&
        visible &&
        createPortal(
          <div
            // Callback ref runs at commit (before paint): position the card
            // from the tracked pointer without reading refs during render.
            ref={(node) => {
              cardRef.current = node;
              if (node) applyPos();
            }}
            role="tooltip"
            aria-hidden
            className={cn(
              // No enter animation: tw-animate keyframes would override the
              // cursor-position transform (card flies in from 0,0), and the
              // card should simply appear at the pointer.
              "pointer-events-none fixed left-0 top-0 z-[100] w-64 rounded-xl border border-border/70 bg-card p-3 shadow-lg ring-1 ring-foreground/5"
            )}
          >
            <div className="flex items-start gap-2.5">
              <ContactAvatar
                contactId={contact.id}
                firstName={contact.firstName}
                fullName={contact.fullName}
                linkedinUrl={contact.linkedinUrl}
                profileImageUrl={contact.profileImageUrl}
                size="lg"
                className="size-14 max-h-14 max-w-14 shrink-0"
              />
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="truncate text-sm font-medium leading-snug text-ink">
                  {displayName}
                </p>
                {contact.title?.trim() ? (
                  <p className="truncate text-xs leading-snug text-muted-foreground">
                    {contact.title.trim()}
                  </p>
                ) : null}
                {contact.company?.trim() ? (
                  <p
                    className="truncate text-xs font-medium leading-snug"
                    style={
                      companyColor ? { color: companyColor } : undefined
                    }
                  >
                    {contact.company.trim()}
                  </p>
                ) : null}
              </div>
            </div>
            {meta ? (
              <p className="mt-2 truncate text-xs text-muted-foreground">
                {meta}
              </p>
            ) : null}
            {(contact.closenessTier ||
              typeof contact.closeness === "number") && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {contact.closenessTier && (
                  <ClosenessTierBadge tier={contact.closenessTier} />
                )}
                {typeof contact.closeness === "number" && (
                  <span
                    className={cn(
                      "rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
                      contact.closenessTier
                        ? closenessTierChipClass(contact.closenessTier)
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    {Math.round(contact.closeness * 100)}%
                  </span>
                )}
              </div>
            )}
            {detail ? (
              <p className="mt-2 truncate text-[11px] text-muted-foreground">
                {detail}
              </p>
            ) : null}
            {summary ? (
              <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                {summary}
              </p>
            ) : null}
          </div>,
          document.body
        )}
    </>
  );
}
