"use client";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { ContactChannelIcons } from "@/components/contacts/contact-profile-icons";
import { ContactEditSheet } from "@/components/contacts/contact-edit-sheet";
import {
  isUnusableAvatarUrl,
  resolveContactPhotoUrl,
} from "@/lib/contact-avatar";
import {
  genderAvatarSrc,
  guessGenderFromFirstName,
} from "@/lib/guess-gender";
import type { ContactInput } from "@/actions/contacts";

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
}) {
  const hasStored =
    Boolean(input.profileImageUrl?.trim()) &&
    !isUnusableAvatarUrl(input.profileImageUrl);
  if (hasStored) return `/api/avatars/${input.contactId}`;
  const resolved = resolveContactPhotoUrl(input.profileImageUrl);
  if (resolved) return resolved;
  return genderAvatarSrc(
    guessGenderFromFirstName(input.firstName, input.fullName)
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
  const previewSrc = resolvePreviewSrc({
    contactId,
    firstName,
    fullName,
    profileImageUrl,
  });

  const roleLine =
    [title, company].filter(Boolean).join(" · ") || "No role yet";
  const metaBits = [school, location].filter(Boolean);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => setCompact(!entry.isIntersecting),
      { threshold: 0, rootMargin: "-12px 0px 0px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <LayoutGroup id={`contact-hero-${contactId}`}>
      <div ref={sentinelRef} className="h-px w-full" aria-hidden />

      <AnimatePresence>
        {compact ? (
          <motion.div
            key="mini-bar"
            layout
            className="sticky top-0 z-20 -mx-4 border-b border-border/60 bg-background/95 px-4 py-2.5 backdrop-blur md:-mx-10 md:px-10"
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-center gap-3">
              <motion.div layoutId={`avatar-${contactId}`} className="shrink-0">
                <ContactAvatar
                  contactId={contactId}
                  firstName={firstName}
                  fullName={fullName}
                  linkedinUrl={linkedinUrl}
                  profileImageUrl={profileImageUrl}
                  size="sm"
                  className="size-9"
                />
              </motion.div>
              <motion.p
                layoutId={`name-${contactId}`}
                className="min-w-0 flex-1 truncate font-[family-name:var(--font-display)] text-lg text-primary"
              >
                {displayName}
              </motion.p>
              <motion.div
                layoutId={`channels-${contactId}`}
                className="hidden sm:block"
              >
                <ContactChannelIcons {...channels} className="justify-end" />
              </motion.div>
              <motion.div layoutId={`edit-${contactId}`}>
                <ContactEditSheet
                  contactId={contactId}
                  name={displayName}
                  initial={formInitial}
                />
              </motion.div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className={compact ? "pt-1 opacity-40" : undefined}>
        <Link
          href="/contacts"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Contacts
        </Link>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 gap-5">
            {!compact ? (
              <motion.div layoutId={`avatar-${contactId}`} className="shrink-0">
                <AvatarHoverPreview
                  src={previewSrc}
                  alt={displayName}
                  enabled
                >
                  <ContactAvatar
                    contactId={contactId}
                    firstName={firstName}
                    fullName={fullName}
                    linkedinUrl={linkedinUrl}
                    profileImageUrl={profileImageUrl}
                    size="lg"
                    className="size-24 sm:size-28"
                  />
                </AvatarHoverPreview>
              </motion.div>
            ) : (
              <div className="size-24 shrink-0 sm:size-28" aria-hidden />
            )}

            <div className="min-w-0 flex-1 pt-1">
              {!compact ? (
                <motion.h1
                  layoutId={`name-${contactId}`}
                  className="font-[family-name:var(--font-display)] text-3xl text-primary sm:text-4xl"
                >
                  {displayName}
                </motion.h1>
              ) : (
                <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary sm:text-4xl">
                  {displayName}
                </h1>
              )}
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

          {!compact ? (
            <div className="flex shrink-0 items-center gap-2">
              <motion.div layoutId={`channels-${contactId}`}>
                <ContactChannelIcons {...channels} />
              </motion.div>
              <motion.div layoutId={`edit-${contactId}`}>
                <ContactEditSheet
                  contactId={contactId}
                  name={displayName}
                  initial={formInitial}
                />
              </motion.div>
            </div>
          ) : (
            <div className="h-9 w-28 shrink-0" aria-hidden />
          )}
        </div>
      </div>
    </LayoutGroup>
  );
}
