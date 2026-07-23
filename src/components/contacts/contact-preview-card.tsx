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
  closenessPercentChipClass,
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
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [mounted, setMounted] = useState(false);
  const openTimer = useRef<number | null>(null);

  useEffect(() => {
    setMounted(true);
    return () => {
      if (openTimer.current) window.clearTimeout(openTimer.current);
    };
  }, []);

  function clearOpenTimer() {
    if (openTimer.current) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }

  function onEnter(e: PointerEvent) {
    setPos(
      clampToViewport(e.clientX + CURSOR_OFFSET, e.clientY + CURSOR_OFFSET)
    );
    clearOpenTimer();
    openTimer.current = window.setTimeout(() => setVisible(true), OPEN_DELAY_MS);
  }

  function onMove(e: PointerEvent) {
    setPos(
      clampToViewport(e.clientX + CURSOR_OFFSET, e.clientY + CURSOR_OFFSET)
    );
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
        onPointerMove={onMove}
        onPointerLeave={onLeave}
      >
        {children}
      </span>
      {mounted &&
        visible &&
        createPortal(
          <div
            role="tooltip"
            aria-hidden
            className={cn(
              "pointer-events-none fixed z-[100] w-64 rounded-xl border border-border/70 bg-card p-3 shadow-lg ring-1 ring-foreground/5"
            )}
            style={{ left: pos.x, top: pos.y }}
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
                <p className="truncate text-sm font-medium leading-snug text-primary">
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
                      closenessPercentChipClass(contact.closeness)
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
