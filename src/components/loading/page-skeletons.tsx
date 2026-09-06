import {
  ConstellationLoading,
  CONSTELLATION_STAGE_HEIGHT,
} from "@/components/graph/constellation-loading";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function PageHeaderSkeleton({
  subtitle = true,
  actions = false,
}: {
  subtitle?: boolean;
  actions?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-2">
        <Skeleton className="h-9 w-48" />
        {subtitle && <Skeleton className="h-4 w-64 max-w-full" />}
      </div>
      {actions && (
        <div className="flex gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-28" />
        </div>
      )}
    </div>
  );
}

export function GenericPageSkeleton() {
  return (
    <div className="space-y-6">
      <PageHeaderSkeleton />
      <Skeleton className="h-40 w-full rounded-2xl" />
      <Skeleton className="h-40 w-full rounded-2xl" />
    </div>
  );
}

/** Matches the reminders page body: list sidebar + reminder rows. */
export function RemindersViewSkeleton() {
  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <div className="w-full space-y-2 md:w-56">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9 rounded-lg" />
        ))}
      </div>
      <div className="flex-1 space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

/** Matches the dashboard's 4-up stat grid (also its Suspense fallback). */
export function DashboardStatRowSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-24 rounded-2xl" />
      ))}
    </div>
  );
}

/** One dashboard card slot; height matches the card it stands in for. */
export function DashboardCardSkeleton({ className }: { className?: string }) {
  return <Skeleton className={`rounded-2xl ${className ?? "h-64"}`} />;
}

export function ContactsPageSkeleton() {
  return (
    <div className="space-y-6">
      <PageHeaderSkeleton actions />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10 rounded-lg" />
        ))}
      </div>
      <div className="overflow-hidden rounded-2xl border border-border/70">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-4 border-b border-border/60 px-5 py-4 last:border-0"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-48" />
            </div>
            <Skeleton className="h-6 w-16 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Matches /recruiters: sharing toggle + Gmail panel + tab bar + list, same shell as Contacts. */
export function RecruitersPageSkeleton() {
  return (
    <div className="space-y-6">
      <PageHeaderSkeleton actions />
      <Skeleton className="h-36 w-full rounded-2xl" />
      <Skeleton className="h-28 w-full rounded-2xl" />
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-9 w-56 rounded-lg" />
        <Skeleton className="h-9 min-w-[16rem] flex-1 rounded-lg" />
      </div>
      <div className="overflow-hidden rounded-2xl border border-border/70">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-4 border-b border-border/60 px-5 py-4 last:border-0"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-48" />
            </div>
            <Skeleton className="h-6 w-16 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Matches /recruiters/[id]: header + rating card + contact card + history card + form. */
export function RecruiterDetailPageSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-4 w-40" />
          <div className="flex gap-2">
            <Skeleton className="h-6 w-16 rounded-full" />
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
        </div>
        <Skeleton className="h-16 w-32 rounded-xl" />
      </div>
      <Skeleton className="h-32 w-full rounded-2xl" />
      <Skeleton className="h-40 w-full rounded-2xl" />
      <Skeleton className="h-52 w-full rounded-2xl" />
      <Skeleton className="h-9 w-40 rounded-lg" />
    </div>
  );
}

export function ContactDetailPageSkeleton() {
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-3">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-10 w-56" />
          <Skeleton className="h-4 w-40" />
          <div className="flex gap-2">
            <Skeleton className="h-6 w-16 rounded-full" />
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-20" />
        </div>
      </div>
      <Skeleton className="h-52 w-full rounded-2xl" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-56 rounded-2xl" />
        <Skeleton className="h-56 rounded-2xl" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-80 w-full rounded-2xl" />
      </div>
    </div>
  );
}

export function FormPageSkeleton({ wide = false }: { wide?: boolean }) {
  return (
    <div className={`space-y-6 ${wide ? "" : "mx-auto max-w-2xl"}`}>
      <PageHeaderSkeleton />
      <div className="space-y-4 rounded-2xl border border-border/70 p-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        ))}
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="mt-2 h-9 w-32" />
      </div>
    </div>
  );
}

/** Matches /capture/[batchId]: the results view, not the capture form it's nested under. */
export function NoteBatchResultSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-9 w-72 max-w-full" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-12 w-full rounded-2xl" />
        <Skeleton className="h-48 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    </div>
  );
}

/**
 * The bordered message panel alone — shared by the route-level `ChatPageSkeleton`
 * (page hasn't rendered yet) and `chat-panel-lazy.tsx`'s dynamic-import fallback
 * (page's own header already rendered; only the client chat bundle is still
 * loading). Takes a `className` so each caller supplies its own sizing instead
 * of duplicating this markup with a different height rule.
 */
export function ChatPanelSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border/70",
        className
      )}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-3">
        <Skeleton className="h-8 w-20" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-56 max-w-full" />
        </div>
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-20" />
      </div>
      <div className="min-h-0 flex-1 basis-0 overflow-hidden p-4">
        <div className="mx-auto w-full max-w-3xl space-y-4">
          <div className="flex justify-end">
            <Skeleton className="h-12 w-2/3 rounded-2xl" />
          </div>
          <div className="flex justify-start">
            <Skeleton className="h-24 w-4/5 rounded-2xl" />
          </div>
          <div className="flex justify-end">
            <Skeleton className="h-10 w-1/2 rounded-2xl" />
          </div>
        </div>
      </div>
      <div className="shrink-0 space-y-2 border-t border-border/60 p-4">
        <div className="mx-auto max-w-3xl space-y-2.5">
          <Skeleton className="h-14 w-full rounded-lg" />
          <div className="flex flex-wrap gap-1.5">
            <Skeleton className="h-6 w-28 rounded-full" />
            <Skeleton className="h-6 w-36 rounded-full" />
            <Skeleton className="h-6 w-32 rounded-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The capture form's field card alone, without the page header — used by
 * `capture-form-lazy.tsx`'s dynamic-import fallback, which mounts after the page's own
 * header has already rendered (see `capture/loading.tsx`'s `FormPageSkeleton` for the
 * route-level version that includes the header).
 */
export function CaptureFormSkeleton() {
  return (
    <div className="space-y-4 rounded-2xl border border-border/70 p-6">
      <Skeleton className="h-9 w-40 rounded-lg" />
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ))}
      <Skeleton className="h-32 w-full rounded-lg" />
      <Skeleton className="mt-2 h-9 w-32" />
    </div>
  );
}

/** Matches /capture: header (no back link, unlike FormPageSkeleton) at the page's own max-w-3xl. */
export function CapturePageSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <CaptureFormSkeleton />
    </div>
  );
}

export function ChatPageSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <div className="shrink-0 space-y-2">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <ChatPanelSkeleton className="flex-1" />
    </div>
  );
}

export function GraphPageSkeleton() {
  // Mirrors the real /graph layout: a three-line header and then the canvas. The old
  // version drew a 4-column stat grid the page has never had, so the skeleton visibly
  // rearranged itself into something else the moment the data arrived.
  return (
    <div className="-mx-1 space-y-3 md:-mx-2">
      <div className="space-y-2 px-1">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <ConstellationLoading className={CONSTELLATION_STAGE_HEIGHT} />
    </div>
  );
}

/**
 * Shared by the admin billing subpages (costs, run-cost, movement, demand): a title,
 * a search bar, a 4-up stat grid, and two chart/table blocks. The four pages were
 * copy-pasting this same shape.
 */
export function AdminBillingSubpageSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-10 w-full max-w-md" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <Skeleton className="h-64" />
      <Skeleton className="h-48" />
    </div>
  );
}

export function ImportsPageSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeaderSkeleton />
      <Skeleton className="h-11 w-full rounded-xl" />
      <Skeleton className="h-56 w-full rounded-2xl" />
      <Skeleton className="h-48 w-full rounded-2xl" />
    </div>
  );
}

export function OnboardingPageSkeleton() {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-lg flex-col justify-center space-y-6">
      <div className="space-y-2 text-center">
        <Skeleton className="mx-auto h-10 w-48" />
        <Skeleton className="mx-auto h-4 w-72" />
      </div>
      <Skeleton className="h-64 w-full rounded-2xl" />
      <Skeleton className="mx-auto h-10 w-36" />
    </div>
  );
}

export function AuthPageSkeleton() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <Skeleton className="mx-auto h-8 w-24" />
          <Skeleton className="mx-auto h-4 w-48" />
        </div>
        <Skeleton className="h-80 w-full rounded-xl" />
      </div>
    </div>
  );
}

/**
 * Mirrors LandingHeader + LandingHeroCopy + HeroPin's two-column layout
 * (src/components/landing/{landing-header,landing-hero,hero-pin}.tsx) — the
 * only part of the scroll narrative that can plausibly still be showing when
 * this loading state is visible. The scenes below the fold lazy-load well
 * after first paint, so skeleton-ing them would just add weight nothing
 * looks at.
 */
export function MarketingPageSkeleton() {
  return (
    // `landing-root` matches the real landing/pricing pages: globals.css paints the
    // body deep-space while it is mounted, so the skeleton doesn't flash the app's
    // light background behind it (e.g. on overscroll) before the real page takes over.
    <div className="landing-root relative flex min-h-svh flex-col overflow-x-clip bg-[#03050c] text-[#e8f3f1]">
      <div className="flex shrink-0 items-center justify-between px-6 py-5 md:px-10">
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-7 rounded-full bg-white/10" />
          <Skeleton className="h-5 w-14 bg-white/10" />
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <Skeleton className="h-8 w-14 rounded-lg bg-white/5" />
          <Skeleton className="h-9 w-24 rounded-full bg-white/10" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-center px-6 pb-6 pt-2 md:px-10 md:pb-10 md:pt-4">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-6 md:gap-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-12">
          <div className="max-w-xl space-y-4">
            <Skeleton className="h-16 w-52 bg-white/10 sm:h-20 md:h-24" />
            <Skeleton className="h-7 w-full max-w-xl bg-white/10 md:h-9" />
            <div className="space-y-2 pt-1">
              <Skeleton className="h-4 w-full max-w-md bg-white/10" />
              <Skeleton className="h-4 w-2/3 max-w-md bg-white/10" />
            </div>
            <div className="hidden gap-3 pt-4 sm:flex">
              <Skeleton className="h-11 w-32 rounded-full bg-white/5" />
              <Skeleton className="h-11 w-28 rounded-full bg-white/10" />
            </div>
          </div>
          <Skeleton className="mx-auto aspect-square w-[min(100%,40svh,300px)] rounded-full bg-white/5 lg:mx-0 lg:w-full lg:max-w-[min(100%,560px)] lg:justify-self-end" />
        </div>
      </div>
    </div>
  );
}

/** The DocHero shape shared by all three (docs) pages: eyebrow, title, lede, meta row. */
function DocHeroSkeleton() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 pb-12 pt-10 md:px-10 md:pb-16 md:pt-14">
      <Skeleton className="h-3 w-20 bg-white/10" />
      <Skeleton className="mt-4 h-11 w-full max-w-md bg-white/10 md:h-14" />
      <div className="mt-6 max-w-[54ch] space-y-2">
        <Skeleton className="h-4 w-full bg-white/5" />
        <Skeleton className="h-4 w-full bg-white/5" />
        <Skeleton className="h-4 w-2/3 bg-white/5" />
      </div>
      <div className="mt-8 grid grid-cols-2 gap-x-8 gap-y-5 border-t border-white/[0.07] pt-6 sm:flex sm:flex-wrap sm:gap-x-12">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i}>
            <Skeleton className="h-2.5 w-16 bg-white/5" />
            <Skeleton className="mt-2 h-3.5 w-20 bg-white/10" />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Matches /privacy and /terms — DocHero + DocHighlights + DocBody (TOC + numbered
 * sections) + DocFooterCta, rendered inside `(docs)/layout.tsx`'s <MarketingDocShell>.
 * That shell's header/switcher/footer are part of the layout, not the page, so they
 * keep rendering normally around this fallback. /contact shares the same hero but a
 * completely different body — see `ContactPageSkeleton` for that one.
 */
export function DocPageSkeleton() {
  return (
    <div className="text-[#e8f3f1]">
      <DocHeroSkeleton />

      <section className="mx-auto w-full max-w-6xl px-6 pb-16 md:px-10 md:pb-20">
        <Skeleton className="h-3 w-32 bg-white/5" />
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <Skeleton className="size-9 rounded-xl bg-white/10" />
              <Skeleton className="mt-4 h-4 w-3/4 bg-white/10" />
              <Skeleton className="mt-2 h-3.5 w-full bg-white/5" />
            </div>
          ))}
        </div>
      </section>

      <div className="mx-auto w-full max-w-6xl px-6 pb-20 md:px-10 md:pb-24">
        <div className="grid gap-10 lg:grid-cols-[196px_minmax(0,1fr)] lg:gap-16">
          {/* Privacy and Terms each run 15+ numbered sections — a handful of stub
              sections at real height would still land nowhere near the real document's
              length, so this favors a shorter, honestly-approximate fallback (this route
              is a synchronous page with no data fetching, so the fallback is rarely seen
              at all) over a very tall list of empty boxes. */}
          <div className="hidden space-y-2 lg:block">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-3 w-full bg-white/5" />
            ))}
          </div>
          <div className="min-w-0 space-y-10">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="space-y-3">
                <Skeleton className="h-6 w-48 bg-white/10" />
                <Skeleton className="h-4 w-full bg-white/5" />
                <Skeleton className="h-4 w-full bg-white/5" />
                <Skeleton className="h-4 w-4/5 bg-white/5" />
              </div>
            ))}
          </div>
        </div>
      </div>

      <section className="mx-auto w-full max-w-6xl px-6 pb-8 md:px-10">
        <div className="flex flex-col gap-6 rounded-3xl border border-white/10 bg-white/[0.02] p-8 sm:p-10 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-3">
            <Skeleton className="h-7 w-64 max-w-full bg-white/10" />
            <Skeleton className="h-4 w-full max-w-md bg-white/5" />
          </div>
          <div className="flex shrink-0 gap-3">
            <Skeleton className="h-11 w-32 rounded-full bg-white/10" />
            <Skeleton className="h-11 w-28 rounded-full bg-white/5" />
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * Matches /contact — DocHero, then topics-list + contact-form two-column section,
 * a 3-up channel-card grid, an FAQ accordion, and a centered closing CTA. Unlike
 * /privacy and /terms this page never uses DocHighlights, DocBody, or DocFooterCta.
 */
export function ContactPageSkeleton() {
  return (
    <div className="text-[#e8f3f1]">
      <DocHeroSkeleton />

      <section className="mx-auto w-full max-w-6xl px-6 pb-16 md:px-10 md:pb-20">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
          <div>
            <Skeleton className="h-3 w-28 bg-white/5" />
            <Skeleton className="mt-3 h-8 w-full max-w-xs bg-white/10" />
            <Skeleton className="mt-4 h-4 w-full bg-white/5" />
            <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-1">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex gap-3.5">
                  <Skeleton className="mt-0.5 size-[18px] shrink-0 rounded-full bg-white/10" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-32 bg-white/10" />
                    <Skeleton className="h-3.5 w-full bg-white/5" />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <Skeleton className="h-96 w-full rounded-3xl border border-white/10 bg-white/[0.02]" />
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl border-t border-white/[0.07] px-6 py-16 md:px-10 md:py-20">
        <Skeleton className="h-3 w-40 bg-white/5" />
        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-3xl border border-white/10 bg-white/[0.02] p-6 sm:p-7">
              <div className="flex items-start justify-between gap-4">
                <Skeleton className="size-10 rounded-xl bg-white/10" />
                <Skeleton className="h-3 w-16 bg-white/5" />
              </div>
              <Skeleton className="mt-5 h-5 w-3/4 bg-white/10" />
              <Skeleton className="mt-2.5 h-3.5 w-full bg-white/5" />
              <Skeleton className="mt-5 h-3.5 w-24 bg-white/10" />
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl border-t border-white/[0.07] px-6 py-16 md:px-10 md:py-20">
        <Skeleton className="h-3 w-32 bg-white/5" />
        <Skeleton className="mt-3 h-8 w-full max-w-sm bg-white/10" />
        <div className="mt-8 grid gap-3 lg:grid-cols-2">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-2xl border border-white/10 bg-white/[0.03]" />
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 pb-8 pt-4 text-center md:px-10">
        <Skeleton className="mx-auto h-8 w-full max-w-md bg-white/10" />
        <Skeleton className="mx-auto mt-4 h-4 w-full max-w-md bg-white/5" />
        <div className="mt-8 flex justify-center gap-3">
          <Skeleton className="h-11 w-24 rounded-full bg-white/5" />
          <Skeleton className="h-11 w-32 rounded-full bg-white/10" />
        </div>
      </section>
    </div>
  );
}

/**
 * Matches /upgrade: header + heading + billing toggle + two plan cards + trust row, on
 * the same dark landing-root ground as /pricing (see that skeleton's comment — this
 * avoids a light-background flash before the deep-space page takes over). This route has
 * no ancestor loading.tsx today, so a direct load/refresh blank-flashes while the layout's
 * `auth()` and the page's three awaited reads resolve; the warp-transition arrival
 * animation only covers that gap when navigating in from the animated liftoff, not here.
 */
export function UpgradePageSkeleton() {
  return (
    <div className="landing-root relative min-h-screen overflow-x-clip bg-[#03050c] text-[#e8f3f1]">
      <div className="relative z-10 mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-6 py-6 md:px-8">
        <div className="flex items-center gap-4">
          <Skeleton className="h-7 w-16 rounded-lg bg-white/5" />
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-7 rounded-full bg-white/10" />
            <Skeleton className="h-5 w-14 bg-white/10" />
          </div>
        </div>
      </div>
      <div className="relative z-10 mx-auto w-full max-w-4xl px-6 pb-24 md:px-8">
        <Skeleton className="h-10 w-full max-w-md bg-white/10 sm:h-12" />
        <div className="mt-12 space-y-8">
          <div className="flex justify-center">
            <Skeleton className="h-9 w-40 rounded-full bg-white/5" />
          </div>
          <div className="grid gap-5 md:grid-cols-2 md:gap-6">
            {[7, 5].map((featureCount, i) => (
              <div
                key={i}
                className="relative rounded-3xl border border-white/10 bg-white/[0.02] p-6"
              >
                {/* The real badge ("Most popular" / "Best value") overlaps the card's top edge. */}
                <Skeleton className="absolute -top-3 left-6 h-6 w-24 rounded-full bg-white/10" />
                <Skeleton className="h-6 w-20 bg-white/10" />
                <Skeleton className="mt-1 h-4 w-full bg-white/5" />
                <Skeleton className="mt-4 h-11 w-28 bg-white/10" />
                <div className="mt-5 space-y-2.5">
                  {Array.from({ length: featureCount }).map((__, j) => (
                    <Skeleton key={j} className="h-4 w-full bg-white/5" />
                  ))}
                </div>
                {/* Only the Lifetime card carries a caveat line below a divider. */}
                {i === 1 && (
                  <div className="mt-4 space-y-1.5 border-t border-white/[0.08] pt-4">
                    <Skeleton className="h-3 w-full bg-white/5" />
                    <Skeleton className="h-3 w-2/3 bg-white/5" />
                  </div>
                )}
                <Skeleton className="mt-5 h-11 w-full rounded-xl bg-white/10" />
              </div>
            ))}
          </div>
          <ul className="grid gap-6 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="flex gap-3.5">
                <Skeleton className="mt-0.5 size-[18px] shrink-0 rounded-full bg-white/10" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-24 bg-white/10" />
                  <Skeleton className="h-3.5 w-full bg-white/5" />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** Matches /suspended: centered notice card on the app's default (light) background. */
export function SuspendedPageSkeleton() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center space-y-3 px-6 py-16">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="mt-4 h-4 w-24" />
    </div>
  );
}

/**
 * Mirrors the real pricing page's section order 1:1 — see
 * src/app/(marketing)/pricing/page.tsx and src/components/pricing/*. Kept in
 * sync deliberately: this is a full-page async Server Component (auth() +
 * two DB reads), so it's the marketing route most likely to actually show a
 * loading state, and a generic skeleton here would visibly jump on swap-in.
 */
export function PricingPageSkeleton() {
  return (
    <div className="landing-root relative overflow-x-clip bg-[#03050c] text-[#e8f3f1]">
      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-6 md:px-10">
        <div className="flex items-center gap-4">
          <Skeleton className="h-7 w-16 rounded-lg bg-white/5" />
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-7 rounded-full bg-white/10" />
            <Skeleton className="h-5 w-14 bg-white/10" />
          </div>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <Skeleton className="h-8 w-14 rounded-lg bg-white/5" />
          <Skeleton className="h-9 w-24 rounded-full bg-white/10" />
        </div>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-6xl px-6 pb-24 md:px-10">
        <section className="flex flex-col items-center gap-4 pt-10 text-center md:pt-16">
          <Skeleton className="h-10 w-full max-w-lg bg-white/10 sm:h-12" />
          <div className="w-full max-w-md space-y-2">
            <Skeleton className="mx-auto h-4 w-full bg-white/10" />
            <Skeleton className="mx-auto h-4 w-4/5 bg-white/10" />
          </div>
        </section>

        <section className="mt-14 space-y-10 md:mt-20">
          <Skeleton className="mx-auto h-11 w-56 rounded-full bg-white/5" />
          <div className="grid items-start gap-5 lg:grid-cols-3 lg:gap-6">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="flex h-full flex-col rounded-3xl border border-white/10 bg-white/[0.02] p-7"
              >
                <Skeleton className="h-7 w-24 bg-white/10" />
                <Skeleton className="mt-4 h-11 w-28 bg-white/10" />
                <Skeleton className="mt-2 h-4 w-full bg-white/10" />
                <div className="mt-6 flex-1 space-y-3">
                  {Array.from({ length: 5 }).map((__, j) => (
                    <Skeleton key={j} className="h-4 w-full bg-white/5" />
                  ))}
                </div>
                <Skeleton className="mt-6 h-11 w-full rounded-xl bg-white/10" />
              </div>
            ))}
          </div>
        </section>

        <section className="mt-20">
          <ul className="grid gap-6 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="flex gap-3.5">
                <Skeleton className="mt-0.5 size-[18px] shrink-0 rounded-full bg-white/10" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-24 bg-white/10" />
                  <Skeleton className="h-3.5 w-full bg-white/5" />
                  <Skeleton className="h-3.5 w-4/5 bg-white/5" />
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-24 md:mt-32">
          <Skeleton className="mx-auto h-8 w-52 bg-white/10" />
          <div className="mt-8 overflow-hidden rounded-3xl border border-white/10">
            <div className="flex items-center gap-4 border-b border-white/[0.08] px-6 py-4">
              <Skeleton className="h-4 w-28 bg-white/10" />
              <div className="ml-auto flex gap-8">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-4 w-12 bg-white/10" />
                ))}
              </div>
            </div>
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-4 border-b border-white/[0.05] px-6 py-3.5 last:border-0"
              >
                <Skeleton className="h-3.5 w-40 bg-white/5" />
                <div className="ml-auto flex gap-8">
                  {Array.from({ length: 3 }).map((__, j) => (
                    <Skeleton key={j} className="size-4 rounded-full bg-white/5" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-24 md:mt-32">
          <Skeleton className="mx-auto h-8 w-64 bg-white/10" />
          <div className="mx-auto mt-10 max-w-3xl divide-y divide-white/[0.08] border-y border-white/[0.08]">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between gap-6 py-5">
                <Skeleton className="h-4 w-2/3 max-w-sm bg-white/10" />
                <Skeleton className="size-4 shrink-0 rounded-full bg-white/5" />
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="relative z-10 mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-4 px-6 py-12 md:px-10">
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-7 rounded-full bg-white/10" />
          <Skeleton className="h-5 w-14 bg-white/10" />
        </div>
        <div className="flex items-center gap-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-14 bg-white/5" />
          ))}
        </div>
        <Skeleton className="h-4 w-24 bg-white/5" />
      </footer>
    </div>
  );
}

/** Mirrors the events list: a filter row and a grid of cover-topped cards. */
export function EventsListSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-24 w-full rounded-2xl" />
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-44 w-full rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

/** Mirrors the event detail shell: themed hero, then the roster. */
export function EventDetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-60 w-full rounded-2xl" />
      <Skeleton className="h-40 w-full rounded-2xl" />
      <Skeleton className="h-72 w-full rounded-2xl" />
    </div>
  );
}
