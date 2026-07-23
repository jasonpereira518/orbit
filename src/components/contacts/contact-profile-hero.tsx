"use client";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { ContactChannelIcons } from "@/components/contacts/contact-profile-icons";
import { ContactEditSheet } from "@/components/contacts/contact-edit-sheet";
import {
  isUnusableAvatarUrl,
  resolveContactPhotoUrl,
} from "@/lib/contact-avatar-url";
import {
  genderAvatarSrc,
  guessGenderFromFirstName,
} from "@/lib/guess-gender";
import type { ContactInput } from "@/actions/contacts";
import { cn } from "@/lib/utils";

type ChannelProps = {
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  website?: string | null;
};

function resolvePreviewSrc(input: {
  contactId: string;
  firstName?: string | null;
  fullName: string;
  profileImageUrl?: string | null;
  linkedinUrl?: string | null;
}) {
  const hasStored =
    Boolean(input.profileImageUrl?.trim()) &&
    !isUnusableAvatarUrl(input.profileImageUrl);
  if (hasStored || input.linkedinUrl?.trim()) {
    return `/api/avatars/${input.contactId}`;
  }
  const resolved = resolveContactPhotoUrl(input.profileImageUrl);
  if (resolved) return resolved;
  return genderAvatarSrc(
    guessGenderFromFirstName(input.firstName, input.fullName)
  );
}

function isDefaultAvatarSrc(src: string) {
  return (
    src.startsWith("/avatars/") ||
    src.includes("/avatars/man.png") ||
    src.includes("/avatars/woman.png") ||
    src.includes("/avatars/default.png")
  );
}

function AvatarHoverPreview({
  src,
  alt,
  enabled,
  children,
}: {
  src: string;
  alt: string;
  enabled: boolean;
  children: ReactNode;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const active = enabled && pos != null;

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={(e) => {
        if (!enabled) return;
        setPos({ x: e.clientX, y: e.clientY });
      }}
      onMouseMove={(e) => {
        if (!enabled) return;
        setPos({ x: e.clientX, y: e.clientY });
      }}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {active && typeof document !== "undefined"
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[100] overflow-hidden rounded-xl border-2 border-border bg-card shadow-2xl"
              style={{
                left: Math.min(pos.x + 16, window.innerWidth - 196),
                top: Math.min(pos.y + 16, window.innerHeight - 196),
                width: 180,
                height: 180,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={alt}
                className="size-full object-cover"
                draggable={false}
              />
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

/** Walk up and collect every element that can scroll (plus window). */
function collectScrollTargets(el: HTMLElement | null): Array<Element | Window> {
  const targets: Array<Element | Window> = [window];
  let node = el?.parentElement ?? null;
  while (node && node !== document.documentElement) {
    const { overflowY } = getComputedStyle(node);
    if (
      overflowY === "auto" ||
      overflowY === "scroll" ||
      overflowY === "overlay"
    ) {
      targets.push(node);
    }
    node = node.parentElement;
  }
  return targets;
}

function StickyMiniBar({
  contactId,
  displayName,
  title,
  firstName,
  fullName,
  linkedinUrl,
  profileImageUrl,
  channels,
  formInitial,
  visible,
  topOffset,
  frame,
}: {
  contactId: string;
  displayName: string;
  title?: string | null;
  firstName?: string | null;
  fullName: string;
  linkedinUrl?: string | null;
  profileImageUrl?: string | null;
  channels: ChannelProps;
  formInitial: Partial<ContactInput> & { tagNames?: string[] };
  visible: boolean;
  topOffset: number;
  frame: { left: number; width: number };
}) {
  if (typeof document === "undefined") return null;

  const role = title?.trim() || null;

  return createPortal(
    <div
      className={cn(
        "fixed z-40 border-b border-border/60 bg-background/95 backdrop-blur transition-[transform,opacity] duration-200",
        visible
          ? "pointer-events-auto translate-y-0 opacity-100"
          : "pointer-events-none -translate-y-full opacity-0"
      )}
      style={{
        top: topOffset,
        left: frame.left,
        width: frame.width,
      }}
      aria-hidden={!visible}
    >
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5 md:px-10">
        <ContactAvatar
          contactId={contactId}
          firstName={firstName}
          fullName={fullName}
          linkedinUrl={linkedinUrl}
          profileImageUrl={profileImageUrl}
          size="sm"
          className="size-9 shrink-0"
        />
        <p className="min-w-0 flex-1 truncate font-[family-name:var(--font-display)] text-lg text-primary">
          {displayName}
          {role ? (
            <>
              <span className="mx-1.5 text-muted-foreground/70" aria-hidden>
                ·
              </span>
              <span className="font-sans text-base font-normal text-muted-foreground">
                {role}
              </span>
            </>
          ) : null}
        </p>
        <div className="hidden sm:block">
          <ContactChannelIcons {...channels} className="justify-end" />
        </div>
        <ContactEditSheet
          contactId={contactId}
          name={displayName}
          initial={formInitial}
        />
      </div>
    </div>,
    document.body
  );
}

export function ContactProfileHero({
  contactId,
  displayName,
  fullName,
  preferredName,
  firstName,
  title,
  company,
  school,
  location,
  profileImageUrl,
  linkedinUrl,
  channels,
  formInitial,
}: {
  contactId: string;
  displayName: string;
  fullName: string;
  preferredName?: string | null;
  firstName?: string | null;
  title?: string | null;
  company?: string | null;
  school?: string | null;
  location?: string | null;
  profileImageUrl?: string | null;
  linkedinUrl?: string | null;
  channels: ChannelProps;
  formInitial: Partial<ContactInput> & { tagNames?: string[] };
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [topOffset, setTopOffset] = useState(0);
  const [frame, setFrame] = useState({ left: 0, width: 0 });
  const previewSrc = resolvePreviewSrc({
    contactId,
    firstName,
    fullName,
    profileImageUrl,
    linkedinUrl,
  });
  const hasRealPhoto =
    Boolean(profileImageUrl?.trim()) && !isUnusableAvatarUrl(profileImageUrl);

  const roleLine =
    [title, company].filter(Boolean).join(" · ") || "No role yet";
  const metaBits = [school, location].filter(Boolean);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    // Viewport-rooted observer — works whether window or an overflow parent scrolls.
    const observer = new IntersectionObserver(
      ([entry]) => {
        setCompact(!entry.isIntersecting);
      },
      {
        root: null,
        // Flip once the sentinel (top of the name row) crosses ~8px under the top edge
        rootMargin: "-8px 0px 0px 0px",
        threshold: 0,
      }
    );
    observer.observe(sentinel);

    function updateFromRect() {
      const el = sentinelRef.current;
      if (!el) return;
      setCompact(el.getBoundingClientRect().top < 8);
    }

    function measureChrome() {
      const el = sentinelRef.current;
      const main =
        el?.closest("main") ?? document.querySelector("main");
      if (main instanceof HTMLElement) {
        const rect = main.getBoundingClientRect();
        setFrame({ left: rect.left, width: rect.width });
      } else {
        setFrame({ left: 0, width: window.innerWidth });
      }

      // Keep the fixed bar below the mobile top header when present
      const mobileHeader = document.querySelector<HTMLElement>("main > header");
      if (mobileHeader && window.matchMedia("(max-width: 767px)").matches) {
        const rect = mobileHeader.getBoundingClientRect();
        setTopOffset(rect.bottom > 0 ? Math.max(0, rect.bottom) : 0);
      } else {
        setTopOffset(0);
      }
    }

    const scrollTargets = collectScrollTargets(sentinel);
    for (const t of scrollTargets) {
      t.addEventListener("scroll", updateFromRect, { passive: true });
      t.addEventListener("scroll", measureChrome, { passive: true });
    }
    window.addEventListener("resize", updateFromRect);
    window.addEventListener("resize", measureChrome);
    measureChrome();
    updateFromRect();

    return () => {
      observer.disconnect();
      for (const t of scrollTargets) {
        t.removeEventListener("scroll", updateFromRect);
        t.removeEventListener("scroll", measureChrome);
      }
      window.removeEventListener("resize", updateFromRect);
      window.removeEventListener("resize", measureChrome);
    };
  }, []);

  return (
    <div>
      {mounted ? (
        <StickyMiniBar
          contactId={contactId}
          displayName={displayName}
          title={title}
          firstName={firstName}
          fullName={fullName}
          linkedinUrl={linkedinUrl}
          profileImageUrl={profileImageUrl}
          channels={channels}
          formInitial={formInitial}
          visible={compact}
          topOffset={topOffset}
          frame={frame}
        />
      ) : null}

      <Link
        href="/contacts"
        className="text-sm text-muted-foreground hover:underline"
      >
        ← Contacts
      </Link>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-5">
        <div className="flex min-w-0 flex-1 items-center gap-5 sm:gap-6">
          <AvatarHoverPreview
            src={previewSrc}
            alt={displayName}
            enabled={
              !compact &&
              hasRealPhoto &&
              !isDefaultAvatarSrc(previewSrc)
            }
          >
            <ContactAvatar
              contactId={contactId}
              firstName={firstName}
              fullName={fullName}
              linkedinUrl={linkedinUrl}
              profileImageUrl={profileImageUrl}
              size="lg"
              className="size-28 sm:size-36"
            />
          </AvatarHoverPreview>

          <div className="min-w-0 flex-1">
            {/* Sentinel: when this leaves the viewport top, show the mini-bar */}
            <div ref={sentinelRef} className="h-px w-px" aria-hidden />
            <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary sm:text-4xl">
              {displayName}
            </h1>
            {preferredName && preferredName !== fullName ? (
              <p className="mt-0.5 text-sm text-muted-foreground">{fullName}</p>
            ) : null}
            <p className="mt-1.5 text-base text-muted-foreground">{roleLine}</p>
            {metaBits.length > 0 ? (
              <p className="mt-1 text-sm text-muted-foreground/90">
                {metaBits.join(" · ")}
              </p>
            ) : null}
          </div>
        </div>

        <div
          className={cn(
            "flex shrink-0 items-center gap-2",
            compact && "invisible"
          )}
          aria-hidden={compact}
        >
          <ContactChannelIcons {...channels} />
          <ContactEditSheet
            contactId={contactId}
            name={displayName}
            initial={formInitial}
          />
        </div>
      </div>
    </div>
  );
}
