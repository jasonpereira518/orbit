"use client";

import Link from "next/link";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ExternalLink, Search, Upload, X } from "lucide-react";
import { LINKEDIN_SHOTS, LinkedInScreenshot } from "@/components/imports/linkedin-screenshot";
import { Stagger, StaggerItem } from "@/components/onboarding/onboarding-ui";
import { Button, buttonVariants } from "@/components/ui/button";
import { linkedInArchiveSearch } from "@/lib/inbox-search";
import {
  LINKEDIN_ARCHIVE_EMAIL_SUBJECT,
  LINKEDIN_ARCHIVE_LINK_HOURS,
  LINKEDIN_DATA_URL,
} from "@/lib/linkedin-export";
import { cn } from "@/lib/utils";

/** Fixed positions, not random: identical on every render and between server and client. */
const STARS: Array<[number, number, number]> = [
  [8, 14, 1.5], [18, 72, 1], [27, 32, 2], [36, 88, 1], [44, 10, 1],
  [58, 80, 1.5], [66, 22, 1], [74, 62, 2], [83, 12, 1.5], [91, 44, 1],
  [12, 50, 1], [52, 48, 1], [95, 84, 1.5], [4, 90, 1], [70, 94, 1],
];

/**
 * The full-screen "Is your LinkedIn export ready?" reminder. A Base UI dialog laid out as a
 * takeover, so focus is trapped, Escape closes it and focus returns to the page.
 *
 * The screen answers the only question that matters a day later — where is that email —
 * with the email itself (subject line and sender, cropped from a real one) and a Gmail
 * search that finds it. Closing it is "Not yet"; the dashboard card keeps both links.
 */
export function LinkedInReminderStage({
  open,
  requested,
  email,
  onClose,
}: {
  open: boolean;
  requested: boolean;
  email: string | null;
  onClose: () => void;
}) {
  const search = linkedInArchiveSearch(email);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()} modal>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-background duration-slow data-closed:duration-base data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup
          aria-labelledby="linkedin-reminder-title"
          aria-describedby="linkedin-reminder-body"
          className="fixed inset-0 z-[90] overflow-y-auto outline-none duration-slow data-closed:duration-base data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        >
          {/* Sky: a soft glow and a few fixed stars, CSS-only, frozen by reduced motion. */}
          <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
            <div className="absolute top-[-35vmax] left-1/2 size-[90vmax] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--primary)_10%,transparent)_0%,transparent_62%)]" />
            {STARS.map(([x, y, r], i) => (
              <span
                key={i}
                className="absolute rounded-full bg-primary/50"
                style={{
                  left: `${x}%`,
                  top: `${y}%`,
                  width: r * 2,
                  height: r * 2,
                  animation: `constellation-twinkle ${3 + (i % 4) * 0.6}s ease-in-out ${i * 0.3}s infinite`,
                }}
              />
            ))}
          </div>

          <DialogPrimitive.Close
            render={
              <Button
                variant="ghost"
                size="icon"
                className="fixed top-4 right-4 z-10 text-muted-foreground sm:top-6 sm:right-6"
              />
            }
          >
            <X className="size-5" aria-hidden />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>

          <div className="relative flex min-h-full items-center justify-center px-4 py-16 sm:px-8">
            <Stagger className="w-full max-w-xl text-center">
              <StaggerItem>
                <p className="text-xs font-medium uppercase tracking-[0.14em] text-primary">
                  Your LinkedIn export
                </p>
              </StaggerItem>
              <StaggerItem>
                <DialogPrimitive.Title
                  id="linkedin-reminder-title"
                  className="mt-3 font-[family-name:var(--font-display)] text-4xl tracking-tight text-ink text-balance sm:text-5xl"
                >
                  Is your LinkedIn export ready?
                </DialogPrimitive.Title>
              </StaggerItem>
              <StaggerItem>
                <p id="linkedin-reminder-body" className="mx-auto mt-4 max-w-md text-base text-muted-foreground text-pretty">
                  {requested
                    ? "It’s been about a day since you asked LinkedIn for your data. It arrives as an email like this one:"
                    : "LinkedIn sends your data archive within a day of requesting it, as an email like this one:"}
                </p>
              </StaggerItem>

              <StaggerItem className="mx-auto mt-6 max-w-md">
                <LinkedInScreenshot shot={LINKEDIN_SHOTS.email} priority className="shadow-lg" />
                <p className="mt-3 text-xs text-muted-foreground">
                  {`Subject: “${LINKEDIN_ARCHIVE_EMAIL_SUBJECT}” · the download link expires ${LINKEDIN_ARCHIVE_LINK_HOURS} hours after it arrives`}
                </p>
              </StaggerItem>

              <StaggerItem className="mt-8 flex flex-col items-stretch justify-center gap-2 sm:flex-row sm:items-center">
                <a
                  href={search.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(buttonVariants({ size: "lg" }), "h-11 px-5 text-[15px]")}
                >
                  <Search className="size-4" aria-hidden />
                  {search.label}
                  <ExternalLink className="size-3.5 opacity-70" aria-hidden />
                </a>
                <Link
                  href="/imports#import-panel-connections"
                  onClick={onClose}
                  className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-11 px-5 text-[15px]")}
                >
                  <Upload className="size-4" aria-hidden />
                  I have it — upload
                </Link>
              </StaggerItem>

              <StaggerItem className="mt-4 flex flex-col items-center gap-2 text-sm">
                <DialogPrimitive.Close
                  render={
                    <button
                      type="button"
                      className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    />
                  }
                >
                  Not yet
                </DialogPrimitive.Close>
                {!requested && (
                  <a
                    href={LINKEDIN_DATA_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                  >
                    Haven&apos;t requested it yet? Open LinkedIn&apos;s export page
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                )}
              </StaggerItem>
            </Stagger>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
