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
};

function roleLine(title: string | null, company: string | null) {
  if (title && company) return `${title} at ${company}`;
  if (title) return title;
  if (company) return company;
  return null;
}

const OPEN_DELAY_MS = 200;
const CURSOR_OFFSET = 14;

export function ContactAvatarPreview({
  contact,
  children,
}: {
  contact: ContactPreviewData;
  children: ReactNode;
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
    setPos({ x: e.clientX + CURSOR_OFFSET, y: e.clientY + CURSOR_OFFSET });
    clearOpenTimer();
    openTimer.current = window.setTimeout(() => setVisible(true), OPEN_DELAY_MS);
  }

  function onMove(e: PointerEvent) {
    setPos({ x: e.clientX + CURSOR_OFFSET, y: e.clientY + CURSOR_OFFSET });
  }

  function onLeave() {
    clearOpenTimer();
    setVisible(false);
  }

  const displayName = contact.preferredName || contact.fullName;
  const role = roleLine(contact.title, contact.company);
  const meta = [contact.school, contact.location].filter(Boolean).join(" · ");

  return (
    <>
      <span
        className="inline-flex shrink-0"
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
            <div className="flex items-start gap-3">
              <ContactAvatar
                contactId={contact.id}
                firstName={contact.firstName}
                fullName={contact.fullName}
                linkedinUrl={contact.linkedinUrl}
                profileImageUrl={contact.profileImageUrl}
                size="lg"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-primary">{displayName}</p>
                {role && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {role}
                  </p>
                )}
                {meta && (
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {meta}
                  </p>
                )}
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
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
