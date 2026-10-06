import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * A cropped, annotated window onto one of the LinkedIn guide screenshots.
 *
 * The source PNGs are full-window captures of a real account. Onboarding and the reminder
 * only ever show the part that teaches something — the "Download my data" card, the
 * archive email's subject line — which also keeps the capture's feed, faces and greeting
 * out of every new user's first minute.
 *
 * Crops and targets are in SOURCE pixels, so they can be read straight off the image; the
 * frame converts them to percentages and scales with its container.
 */

export type ScreenshotCrop = { x: number; y: number; w: number; h: number };

export type ScreenshotTarget = {
  /** Box in source pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  shape: "circle" | "pill";
  label: string;
  /**
   * The source already circles this spot (LinkedIn's Request archive button carries a
   * hand-drawn ellipse), so draw only the ping and the number, not a second ring.
   */
  annotated?: boolean;
};

type Shot = {
  src: string;
  width: number;
  height: number;
  alt: string;
  crop: ScreenshotCrop;
  targets: ScreenshotTarget[];
};

export const LINKEDIN_SHOTS = {
  /** LinkedIn's "Download my data" card: the archive radio and Request archive (2x capture). */
  request: {
    src: "/guides/linkedin/request-archive.png",
    width: 1486,
    height: 1006,
    alt: "LinkedIn's Download my data page with “Download larger data archive” selected and the Request archive button",
    crop: { x: 40, y: 120, w: 1406, h: 700 },
    targets: [
      { x: 88, y: 289, w: 48, h: 48, shape: "circle", label: "1" },
      { x: 90, y: 655, w: 311, h: 75, shape: "pill", label: "2" },
    ],
  },
  /** The email that says the archive is ready: subject and sender only (2x capture). */
  email: {
    src: "/guides/linkedin/archive-email.png",
    width: 1208,
    height: 402,
    alt: "The email from LinkedIn titled “Your full LinkedIn data archive is ready!”",
    crop: { x: 20, y: 20, w: 1100, h: 200 },
    targets: [],
  },
} satisfies Record<string, Shot>;

const pct = (n: number) => `${n * 100}%`;

export function LinkedInScreenshot({
  shot,
  priority,
  className,
}: {
  shot: Shot;
  priority?: boolean;
  className?: string;
}) {
  const { crop } = shot;
  return (
    <figure
      className={cn(
        "relative overflow-hidden rounded-xl border border-border/70 bg-white shadow-sm",
        className,
      )}
      style={{ aspectRatio: `${crop.w} / ${crop.h}` }}
    >
      <Image
        src={shot.src}
        width={shot.width}
        height={shot.height}
        alt={shot.alt}
        priority={priority}
        // Served as-is: these are 2x captures, and a resized variant picked for the frame's
        // width came out soft. The PNGs are small enough that the original is the right file.
        unoptimized
        draggable={false}
        className="pointer-events-none absolute max-w-none select-none"
        style={{
          width: pct(shot.width / crop.w),
          height: "auto",
          left: pct(-crop.x / crop.w),
          top: pct(-crop.y / crop.h),
        }}
      />
      {shot.targets.map((t) => (
        <span
          key={t.label}
          aria-hidden
          className="pointer-events-none absolute"
          style={{
            left: pct((t.x - crop.x) / crop.w),
            top: pct((t.y - crop.y) / crop.h),
            width: pct(t.w / crop.w),
            height: pct(t.h / crop.h),
          }}
        >
          <span
            className={cn(
              "onboarding-target-ping absolute inset-0 border-2 border-primary",
              t.shape === "circle" ? "rounded-full" : "rounded-[999px]",
            )}
          />
          {!t.annotated && (
            <span
              className={cn(
                "absolute inset-0 border-2 border-primary/80",
                t.shape === "circle" ? "rounded-full" : "rounded-[999px]",
              )}
            />
          )}
          <span className="absolute -top-2.5 -right-2.5 flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground shadow-sm">
            {t.label}
          </span>
        </span>
      ))}
    </figure>
  );
}
