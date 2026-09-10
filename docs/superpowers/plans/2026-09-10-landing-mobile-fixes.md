# Landing Page Mobile Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the marketing landing page's production-visible defects on phones: blank planets, a header that text ghosts through, and undersized tap targets. Then prove the result in real Chromium and real WebKit.

**Architecture:** Three independent fixes shipped as two PRs. PR A is the existing PR #134 (proxy matcher + guard), rebased and merged. PR B is this branch: it restores the glass blur by cherry-picking the already-verified commit `aec733b` and adds a guard against regression, then replaces three copy-pasted footers with one `MarketingFooter` that has 44px targets and gives the header buttons a 44px hit area. Every fix ships with a `scripts/smoke-*.ts` guard that fails on the old code.

**Tech Stack:** Next.js 16.2 (Turbopack), Tailwind v4 (Lightning CSS), Clerk middleware in `src/proxy.ts`, `tsx` smoke scripts run by `scripts/run-smoke.ts`.

**Spec:** The mobile audit of 2026-09-08 (375×812 and 320×720), re-verified against production on 2026-09-10. Its evidence is reproduced under **Findings** below; there is no separate spec document.

## Global Constraints

- Read the relevant guide in `node_modules/next/dist/docs/` before touching `src/proxy.ts` or any Next config. This Next version has breaking changes (see `AGENTS.md`).
- Never hand-write `-webkit-backdrop-filter` in CSS. Lightning CSS then emits *only* the prefixed form, which Chromium and Firefox ignore.
- Tailwind scans code comments and compiles any utility class written there. Do not put arbitrary-value classes (anything with `[...]`) in comments.
- Smoke scripts live at `scripts/smoke-<name>.ts`, must be registered in `MANIFEST` in `scripts/run-smoke.ts` (tier `"pure"`), and must end with an explicit `process.exit(0)`, or `process.exit(1)` on failure. `npm run test:check` fails if a script on disk is missing from the manifest.
- This is a refinement: copy, font sizes, colors (including the existing hex values), and motion are unchanged.
- No database or `SCHEMA_VERSION` changes.
- Never `pkill` dev servers. Ports 3000–3010 belong to other worktrees. Start this worktree's server with the preview tool's `orbit-web` config (`autoPort`).
- `npm run lint` must stay at 0 errors (the baseline is 0 errors / ~36 warnings).
- **Verification surfaces:** the in-app Browser pane is Chromium and runs at `visibilityState: hidden` unless displayed. **Computed styles and layout of the server-rendered landing page are reliable there; animation and IntersectionObserver are not.** Before trusting any pane probe, assert `document.body.innerText.length > 2000`. Real WebKit layout comes from the iOS Simulator, driven with `xcrun simctl`.

---

## Findings (what this plan fixes, ranked)

| # | Severity | Finding | Evidence | Who is affected |
|---|---|---|---|---|
| 1 | **P0** | Hero sun and planets render blank in production | `curl -H 'Sec-Fetch-Dest: image' https://orbit.jasonpereira.live/landing/planets/sun.avif` returns `404 text/html` with `x-clerk-auth-reason: protect-rewrite`. The matcher in `src/proxy.ts` has no `avif`. A `<picture>` commits to the AVIF `<source>` and never falls back to the `.webp` or `.png`. | Every signed-out visitor on an AVIF-capable browser (Safari 16+, Chrome, Firefox) |
| 2 | **P1** | Page text ghosts through the fixed header (glass blur is dead) | Production CSS ships `.landing-header-glass{-webkit-backdrop-filter:blur(24px)saturate(1.4)}` with **no** standard property; same for `.liquid-glass` and `.landing-glass`. In Chromium `getComputedStyle(...).backdropFilter === "none"`. Seen at every scroll depth past the hero. | Chrome, Android, Edge, Firefox. **Not iOS Safari**, which honors the prefix, so the Simulator cannot verify this fix. |
| 3 | **P2** | Undersized tap targets on the only phone CTA and in the footer | Header "Sign in" and "Get Started" are 36px tall, and they are the page's only CTAs on a phone until the finale (the hero hides its pair below `md`, deliberately). Footer links are 20px tall; at 320px "Interest list" wraps onto two lines (measured at 40px). The footer markup is pasted into three pages. | All mobile visitors |

**Already verified working (do not change):** no horizontal scroll at 320 or 375; the hero intro, the three-beat hero-pin scrub, the constellation draw, scroll reveals, and the credit shimmer all run correctly; the reduced-motion handling (a scoped `0.01ms` global clamp plus `HeroPin`'s gate) is correct.

**Existing work this plan reuses rather than redoes:**
- PR #134 (`claude/fix-avif-auth-redirect`): the matcher fix plus a guard that scans every extension in `public/`. It is 1 commit, 127 behind main, and merges cleanly.
- Commit `aec733b` (inside PR #154, `claude/mobile-constellation-crash-f6a19d`) deletes the four `-webkit-backdrop-filter` twins and moves `viewTransitionName` off the mobile nav's glass ancestor. It cherry-picks cleanly onto main. PR #154 is a +5405/−1690 `/graph` rewrite that shouldn't gate a landing fix. The cherry-picked commit is byte-identical, so #154 still merges cleanly afterward.

## File Map

| File | Change | Task |
|---|---|---|
| `src/proxy.ts` | Add `avif` to the matcher's skip list (already done in #134) | 1 |
| `scripts/smoke-public-routes.ts` | Guard for public asset extensions (already in #134); fix failure wording | 1 |
| `scripts/smoke-backdrop-filter.ts` | **Create.** Fails on any hand-written `-webkit-backdrop-filter` declaration, or a glass class without a standard blur | 2 |
| `src/app/globals.css` | Four twin lines deleted (via `aec733b`) | 2 |
| `src/components/layout/mobile-nav.tsx` | `viewTransitionName` moved to `<ul>` (via `aec733b`) | 2 |
| `src/components/marketing/marketing-footer.tsx` | **Create.** The one marketing footer: 44px links, wrapping row, `nav` landmark | 3 |
| `src/components/landing/landing-scenes.tsx` | Lines 197–253: inline footer → `<MarketingFooter>`; drop the now-unused `OrbitLogo` import | 3 |
| `src/app/(marketing)/pricing/page.tsx` | Lines 205–246: inline footer → `<MarketingFooter>` | 3 |
| `src/app/(marketing)/interest/page.tsx` | Lines 235–264: inline footer → `<MarketingFooter>`; delete `FOOTER_LINK` (line 23) | 3 |
| `src/components/landing/landing-auth-controls.tsx` | Lines 8–11: `ghostClass` and `solidClass` gain a 44px `::after` hit area | 3 |
| `scripts/smoke-marketing-footer.ts` | **Create.** Render checks + one-footer structural checks + header hit-area checks | 3 |
| `scripts/run-smoke.ts` | Register the two new smoke scripts in `MANIFEST` | 2, 3 |

---

### Task 1: Planets render in production (land PR #134)

**Files:**
- Modify: `src/proxy.ts` (matcher, already changed on the PR branch)
- Modify: `scripts/smoke-public-routes.ts:132-134` (failure wording)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing other tasks import. PR B does not depend on this PR.

- [ ] **Step 1: Check out the PR branch in its own worktree and install**

```bash
git fetch origin claude/fix-avif-auth-redirect
git worktree add /Users/jasonpereira/Projects/orbit/.claude/worktrees/avif-fix -B claude/fix-avif-auth-redirect origin/claude/fix-avif-auth-redirect
cd /Users/jasonpereira/Projects/orbit/.claude/worktrees/avif-fix
npm ci
```

If `worktree add` reports the branch is already checked out elsewhere, `cd` into that worktree instead. Worktrees have no `node_modules` of their own; don't symlink main's.

- [ ] **Step 2: Bring it up to date with main**

```bash
git merge origin/main -m "Merge origin/main into fix-avif-auth-redirect"
```

Expected: a clean merge (verified 2026-09-10 with `git merge-tree`).

- [ ] **Step 3: Prove the guard catches the bug**

Temporarily remove `avif|` from the matcher's extension list in `src/proxy.ts`, then run:

```bash
npx tsx scripts/smoke-public-routes.ts; echo "exit=$?"
```

Expected: a line reading `FAIL .avif bypasses middleware (/landing/planets/earth.avif)` (the example path may name another planet), the `FAILED:` message, and `exit=1`. Restore `avif|` with `git checkout src/proxy.ts`.

- [ ] **Step 4: Make the failure message match what production actually does**

Production answers a gated asset with Clerk's `protect-rewrite` 404, not a 307. In `scripts/smoke-public-routes.ts`, replace:

```ts
        ` 307 to /sign-in in production instead of serving. Add the extension to the` +
```

with:

```ts
        ` be answered by Clerk in production (a 404 protect-rewrite for a signed-out` +
        ` asset request, or a 307 to /sign-in) instead of serving. Add the extension to the` +
```

- [ ] **Step 5: Run the guard, types, and lint**

```bash
npx tsx scripts/smoke-public-routes.ts; echo "exit=$?"
npm run typecheck
npm run lint 2>&1 | tail -3
```

Expected: every line `ok`, including `ok   .avif bypasses middleware`, then `exit=0`; typecheck clean; lint `0 errors`.

- [ ] **Step 6: Commit, push, and note the production evidence on the PR**

```bash
git add scripts/smoke-public-routes.ts
git commit -m "Say what production actually answers for a gated asset

Clerk rewrites a signed-out asset request to a 404 (x-clerk-auth-reason:
protect-rewrite); only document requests get the 307.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin claude/fix-avif-auth-redirect
gh pr comment 134 --body "Re-verified against production on 2026-09-10 (prod = main @ 04a9763): \`/landing/planets/*.avif\` returns **404 text/html** with \`x-clerk-auth-reason: protect-rewrite, session-token-and-uat-missing\`. The status is now a 404 rather than the 307 described above, but the root cause is the same. Rebased on main and the guard message updated to match."
```

- [ ] **Step 7: Merge (Jason's call), then verify production**

After the merge deploys, confirm prod is serving the merge commit (a failed deploy pins prod to an older SHA), then probe every AVIF the way a browser's `<img>` does:

```bash
gh api "repos/{owner}/{repo}/deployments?environment=Production&per_page=1" --jq '.[0].sha[0:7]'
git rev-parse --short origin/main
for p in earth jupiter mars mercury neptune saturn sun uranus venus; do
  printf "%-8s " "$p"
  curl -s -o /dev/null -w "%{http_code} %{content_type}\n" -H 'Accept: image/avif,image/webp,*/*' -H 'Sec-Fetch-Dest: image' "https://orbit.jasonpereira.live/landing/planets/$p.avif"
done
```

Expected: the two SHAs match, and all nine lines read `200 image/avif`.

---

### Task 2: Glass surfaces blur in Chromium (restore + guard)

**Files:**
- Create: `scripts/smoke-backdrop-filter.ts`
- Modify: `scripts/run-smoke.ts` (`MANIFEST`)
- Modify: `src/app/globals.css:428,704,1237,1260` and `src/components/layout/mobile-nav.tsx` (via cherry-pick of `aec733b`)

**Interfaces:**
- Consumes: nothing.
- Produces: the `smoke-backdrop-filter` manifest entry. Task 4 relies on `.landing-header-glass` computing to `blur(24px) saturate(1.4)`.

Work in this worktree (`reverent-lehmann-ec3cda`, branch `claude/orbit-mobile-flow-testing-63d27f`, already fast-forwarded to `origin/main` @ `04a9763`).

- [ ] **Step 1: Write the guard**

Create `scripts/smoke-backdrop-filter.ts`:

```ts
/**
 * Glass surfaces must declare only the standard `backdrop-filter`.
 *
 * Tailwind v4 compiles globals.css through Lightning CSS. When a rule hand-writes the
 * prefixed twin next to the standard property, the build keeps ONLY the prefixed form.
 * Chromium and Firefox ignore that, so the blur silently dies while every other declaration
 * still applies. On the landing page this let headings ghost through the fixed header
 * everywhere except Safari. Lightning CSS adds whatever prefix the browserslist needs on
 * its own; writing it by hand is the bug.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
/** Classes whose whole point is the blur. Deleting BOTH lines must fail too, not just the twin. */
const MUST_BLUR = [".liquid-glass", ".landing-glass", ".landing-header-glass"];

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Blank out comments but keep their newlines, so reported line numbers stay true. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...cssFiles(full));
    else if (entry.endsWith(".css")) out.push(full);
  }
  return out;
}

function main() {
  console.log("Hand-written prefixed twins:");
  for (const file of cssFiles(SRC)) {
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    // Declarations only: a line that STARTS with the property. An @supports condition such
    // as `(-webkit-backdrop-filter: blur(1px))` starts with "(" and is left alone.
    const hits = lines.flatMap((line, i) =>
      /^\s*-webkit-backdrop-filter\s*:/.test(line) ? [`${file}:${i + 1}`] : []
    );
    check(`${file} declares no -webkit-backdrop-filter`, hits.length === 0, hits.join(", "));
  }

  console.log("\nGlass classes still blur:");
  const globals = stripComments(readFileSync(join(SRC, "app/globals.css"), "utf8"));
  for (const selector of MUST_BLUR) {
    // The top-level rule for exactly this selector: unindented, and `.liquid-glass-panel`
    // does not match `.liquid-glass` because the brace must follow the name.
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rule = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(globals);
    const body = rule?.[2] ?? "";
    check(
      `${selector} declares a standard backdrop-filter blur`,
      /(^|[;\s{])backdrop-filter\s*:\s*blur\(/.test(body),
      rule ? "" : "rule not found"
    );
  }

  if (failures > 0) {
    console.error(
      `\nFAILED: ${failures} check(s). Author only the standard \`backdrop-filter\`; Lightning CSS adds the prefix.`
    );
    process.exit(1);
  }
  console.log("\nEvery glass surface blurs.");
  process.exit(0);
}

main();
```

- [ ] **Step 2: Register it**

In `scripts/run-smoke.ts`, in `MANIFEST`'s `pure` block, insert between `"smoke-avatar-storage": "pure",` and `"smoke-capture-body-limits": "pure",`:

```ts
  "smoke-backdrop-filter": "pure",
```

- [ ] **Step 3: Run it and watch it fail for the right reason**

```bash
npx tsx scripts/smoke-backdrop-filter.ts; echo "exit=$?"
```

Expected: `FAIL src/app/globals.css declares no -webkit-backdrop-filter — src/app/globals.css:428, src/app/globals.css:704, src/app/globals.css:1237, src/app/globals.css:1260`, then three `ok` lines for the glass classes, then `exit=1`. Line 577 (the `@supports` condition) must **not** appear. If it does, the declaration regex is wrong.

- [ ] **Step 4: Cherry-pick the verified fix**

```bash
git cherry-pick aec733b
```

Expected: it applies cleanly and touches `src/app/globals.css` (4 deletions) and `src/components/layout/mobile-nav.tsx`. It also moves `viewTransitionName` from the mobile nav's `<nav>` to its `<ul>`. An element with `view-transition-name` is a backdrop root, so a glass pill beneath it can't blur even once the property is restored. There is no `view-transition-name` anywhere above the landing header, so the landing page needs only the CSS half.

- [ ] **Step 5: Run the guard and the manifest check**

```bash
npx tsx scripts/smoke-backdrop-filter.ts; echo "exit=$?"
npm run test:check
```

Expected: all `ok`, `Every glass surface blurs.`, `exit=0`; `test:check` passes.

- [ ] **Step 6: Verify the compiled result in Chromium**

Start this worktree's dev server with the preview tool (`preview_start` name `orbit-web`; note the port). Load `/` in the pane at `resize_window` preset `mobile`, then run:

```js
({ text: document.body.innerText.length,
   header: getComputedStyle(document.querySelector('.landing-header-glass')).backdropFilter })
```

Expected: `text` > 2000 and `header === "blur(24px) saturate(1.4)"`. On main before the cherry-pick this read `"none"`.

- [ ] **Step 7: Commit the guard**

```bash
git add scripts/smoke-backdrop-filter.ts scripts/run-smoke.ts
git commit -m "Guard glass surfaces against the prefixed-only backdrop-filter

A hand-written -webkit- twin makes Lightning CSS emit only the prefix,
which Chromium and Firefox ignore. Fails on any such declaration, and on
a glass class that loses its standard blur altogether.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Thumb-sized targets (one `MarketingFooter` + header hit area)

**Files:**
- Create: `src/components/marketing/marketing-footer.tsx`
- Create: `scripts/smoke-marketing-footer.ts`
- Modify: `scripts/run-smoke.ts` (`MANIFEST`)
- Modify: `src/components/landing/landing-scenes.tsx:7,197-253`
- Modify: `src/app/(marketing)/pricing/page.tsx:205-246`
- Modify: `src/app/(marketing)/interest/page.tsx:23,235-264`
- Modify: `src/components/landing/landing-auth-controls.tsx:8-11`

**Interfaces:**
- Consumes: `OrbitLogo` from `@/components/orbit-logo` (prop `size="sm"`), `cn` from `@/lib/utils`.
- Produces: `export function MarketingFooter({ className, children }: { className?: string; children?: ReactNode }): JSX.Element`. It renders `<footer>` containing the logo link, a `<nav aria-label="Footer">` with four links, and the credit link, all at `min-h-11`.

- [ ] **Step 1: Write the failing smoke test**

Create `scripts/smoke-marketing-footer.ts`:

```ts
/**
 * The marketing footer: one component, thumb-sized links, and the header's two buttons with
 * a 44px hit area.
 *
 * Rendering pins what a visitor can reach. The structural checks pin why the component
 * exists: the footer used to be pasted into three pages, and a fix applied to one copy is a
 * fix the other two never get.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketingFooter } from "../src/components/marketing/marketing-footer";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Source with comments stripped, so prose describing a rule never counts as code. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const PAGES = [
  "src/components/landing/landing-scenes.tsx",
  "src/app/(marketing)/pricing/page.tsx",
  "src/app/(marketing)/interest/page.tsx",
];

function main() {
  console.log("Footer renders:");
  const html = renderToStaticMarkup(
    React.createElement(MarketingFooter, { className: "max-w-4xl" })
  );
  for (const href of ["/", "/pricing", "/interest", "/privacy", "/contact", "https://jasonpereira.live/"]) {
    check(`links to ${href}`, html.includes(`href="${href}"`));
  }
  const anchorClasses = [...html.matchAll(/<a\b[^>]*class="([^"]*)"/g)].map((m) => m[1]);
  check(
    "every footer link is a 44px-tall box",
    anchorClasses.length === 6 && anchorClasses.every((c) => c.split(/\s+/).includes("min-h-11")),
    `${anchorClasses.length} links`
  );
  check(
    '"Interest list" cannot wrap onto two lines',
    /class="[^"]*\bwhitespace-nowrap\b[^"]*"[^>]*>Interest list</.test(html)
  );
  check("the page's column classes are applied", html.includes("max-w-4xl"));
  check("the link row is a labelled nav landmark", html.includes('<nav aria-label="Footer"'));

  console.log("\nOne footer, not three copies:");
  for (const page of PAGES) {
    const src = code(page);
    check(`${page} renders <MarketingFooter`, src.includes("<MarketingFooter"));
    check(`${page} has no inline <footer>`, !/<footer\b/.test(src));
  }

  console.log("\nHeader buttons:");
  const auth = code("src/components/landing/landing-auth-controls.tsx");
  for (const name of ["ghostClass", "solidClass"]) {
    const value = new RegExp(`const ${name}\\s*=\\s*"([^"]*)"`).exec(auth)?.[1] ?? "";
    const classes = value.split(/\s+/);
    check(
      `${name} extends its hit area to 44px`,
      ["relative", "after:absolute", "after:inset-x-0", "after:-inset-y-1"].every((c) => classes.includes(c)),
      value || "not found"
    );
  }

  if (failures > 0) {
    console.error(`\nFAILED: ${failures} check(s).`);
    process.exit(1);
  }
  console.log("\nMarketing footer and header targets are thumb-sized.");
  process.exit(0);
}

main();
```

- [ ] **Step 2: Register it and watch it fail**

In `scripts/run-smoke.ts`, in `MANIFEST`'s `pure` block, insert between `"smoke-locked-participant": "pure",` and `"smoke-mention-resolution": "pure",`:

```ts
  "smoke-marketing-footer": "pure",
```

```bash
npx tsx scripts/smoke-marketing-footer.ts; echo "exit=$?"
```

Expected: it crashes on import with `Cannot find module '../src/components/marketing/marketing-footer'`, then `exit=1`.

- [ ] **Step 3: Create the component**

Create `src/components/marketing/marketing-footer.tsx`:

```tsx
import Link from "next/link";
import type { ReactNode } from "react";
import { OrbitLogo } from "@/components/orbit-logo";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/pricing", label: "Pricing" },
  { href: "/interest", label: "Interest list" },
  { href: "/privacy", label: "Privacy" },
  { href: "/contact", label: "Contact" },
] as const;

const LINK_CLASS =
  "inline-flex min-h-11 items-center whitespace-nowrap text-sm text-[#6d807c] transition-colors hover:text-[#e8f3f1]";

/**
 * The footer every marketing page ends on. It used to be pasted into three pages, which is
 * how its links ended up 20px tall on all of them at once.
 *
 * Every link is a 44px-tall box, the comfortable thumb target, while the text stays
 * text-sm. The link row wraps rather than squeezing, so "Interest list" never breaks
 * across two lines on a 320px phone. The boxes already carry their own vertical air, which
 * is why the gaps between wrapped rows are tighter than the old ones.
 */
export function MarketingFooter({
  className,
  children,
}: {
  /** Width and horizontal padding: each page's column differs. */
  className?: string;
  /** Decoration anchored on the footer's own box (the landing page's glow). */
  children?: ReactNode;
}) {
  return (
    <footer
      className={cn(
        "relative z-10 mx-auto flex w-full flex-wrap items-center justify-between gap-x-6 gap-y-2 py-12",
        className
      )}
    >
      {children}
      <Link href="/" className="flex min-h-11 items-center gap-2.5" aria-label="Orbit home">
        <OrbitLogo size="sm" />
        <span className="font-[family-name:var(--font-display)] text-[17px] tracking-tight text-[#e8f3f1]">
          Orbit
        </span>
      </Link>
      <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-5">
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href} className={LINK_CLASS}>
            {link.label}
          </Link>
        ))}
      </nav>
      <a
        href="https://jasonpereira.live/"
        target="_blank"
        rel="noopener noreferrer"
        className="landing-credit-shimmer inline-flex min-h-11 items-center text-sm"
      >
        By Jason Pereira
      </a>
    </footer>
  );
}
```

The credit link can safely become a taller box: `.landing-credit-shimmer` paints with `background-clip: text` and a horizontal 220%-wide gradient, so the glyphs look the same.

- [ ] **Step 4: Run it: render checks pass, structure still fails**

```bash
npx tsx scripts/smoke-marketing-footer.ts; echo "exit=$?"
```

Expected: the ten `Footer renders` checks read `ok`; all six `One footer` checks and both `Header buttons` checks read `FAIL`; `exit=1`.

- [ ] **Step 5: Replace the landing footer**

In `src/components/landing/landing-scenes.tsx`, replace everything from line 197 (`<footer className="relative z-10 mx-auto flex w-full max-w-4xl ...">`) through its closing `</footer>` (line 253) with:

```tsx
      <MarketingFooter className="max-w-4xl">
        {/* Anchored on the footer's own box rather than offset from the
         * section above — a negative-offset sibling glow faded out before it
         * reached this text. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[560px] w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full md:h-[900px] md:w-[900px]"
          style={{
            background:
              "radial-gradient(circle, rgba(242,193,78,0.14), transparent 62%)",
          }}
        />
      </MarketingFooter>
```

Then fix the imports. Add `import { MarketingFooter } from "@/components/marketing/marketing-footer";`. Delete line 7 (`import { OrbitLogo } from "@/components/orbit-logo";`), since the footer was its only use. Keep `Link`: one other `<Link` remains in the file.

- [ ] **Step 6: Replace the pricing and interest footers**

In `src/app/(marketing)/pricing/page.tsx`, replace line 205 (`<footer className="relative z-10 mx-auto flex w-full max-w-6xl ... md:px-10">`) through its `</footer>` (line 246) with:

```tsx
      <MarketingFooter className="max-w-6xl px-6 md:px-10" />
```

In `src/app/(marketing)/interest/page.tsx`, replace line 235 (the same `<footer ...>` opening) through its `</footer>` (line 264) with the same line. Then delete line 23 (`const FOOTER_LINK = ...`): the footer was its only user.

In both files add `import { MarketingFooter } from "@/components/marketing/marketing-footer";`. Keep their `Link` and `OrbitLogo` imports, which are still used by each page's header and body. Confirm:

```bash
for f in "src/app/(marketing)/pricing/page.tsx" "src/app/(marketing)/interest/page.tsx" src/components/landing/landing-scenes.tsx; do
  echo "$f  <Link:$(command grep -c '<Link' "$f")  <OrbitLogo:$(command grep -c '<OrbitLogo' "$f")  FOOTER_LINK:$(command grep -c 'FOOTER_LINK' "$f")"
done
```

Expected: pricing `1 1 0`, interest `2 1 0`, landing-scenes `1 0 0`. Any import whose count is 0 must be gone.

- [ ] **Step 7: Give the header buttons a 44px hit area**

In `src/components/landing/landing-auth-controls.tsx`, replace lines 8–11:

```ts
const ghostClass =
  "rounded-lg px-3 py-2 text-sm text-[#c5d4d1] transition-colors hover:text-white";
const solidClass =
  "rounded-full bg-[#e8f3f1] px-4 py-2 text-sm font-medium text-[#0f3d3e] transition-colors hover:bg-white";
```

with:

```ts
// On a phone these two are the page's only calls to action until the finale (the hero hides
// its pair below md), and their boxes are 36px tall. The ::after layer adds 4px above and
// below: 44px to a thumb, the same pill to the eye, and still inside the 52px header pill.
const ghostClass =
  "relative rounded-lg px-3 py-2 text-sm text-[#c5d4d1] transition-colors after:absolute after:inset-x-0 after:-inset-y-1 hover:text-white";
const solidClass =
  "relative rounded-full bg-[#e8f3f1] px-4 py-2 text-sm font-medium text-[#0f3d3e] transition-colors after:absolute after:inset-x-0 after:-inset-y-1 hover:bg-white";
```

Tailwind v4 adds `content: var(--tw-content)` to every `after:` utility, so no `after:content-*` class is needed. Step 9's hit test confirms it.

- [ ] **Step 8: Run everything**

```bash
npx tsx scripts/smoke-marketing-footer.ts; echo "exit=$?"
npm run test:check
npm run typecheck
npm run lint 2>&1 | tail -3
```

Expected: every check `ok`, then `Marketing footer and header targets are thumb-sized.` and `exit=0`; `test:check` passes; typecheck clean; lint `0 errors`.

- [ ] **Step 9: Measure the real targets in Chromium**

With the dev server running, load `/` in the pane at `resize_window` preset `mobile` (375×812), then run:

```js
const a = [...document.querySelectorAll('a')];
const header = a.filter(x => /^(Sign in|Get Started)$/.test(x.textContent.trim()) && x.getBoundingClientRect().top < 80);
const hit = header.map(x => { const r = x.getBoundingClientRect(), cx = r.left + r.width / 2;
  return { text: x.textContent.trim(), box: Math.round(r.height),
    above: x.contains(document.elementFromPoint(cx, r.top - 3)),
    below: x.contains(document.elementFromPoint(cx, r.bottom + 3)) }; });
const foot = [...document.querySelectorAll('footer a')].map(x => ({ text: x.textContent.trim(), h: Math.round(x.getBoundingClientRect().height) }));
({ text: document.body.innerText.length, scrollW: document.documentElement.scrollWidth, vw: innerWidth, hit, foot })
```

Expected: `text` > 2000; `scrollW === vw`; both header entries have `box: 36`, `above: true`, `below: true` (on main both read `false`); every footer entry has `h: 44`. Repeat at `resize_window` 320×720: "Interest list" must still be `h: 44` (on main it measured 40, because it wrapped). Reset with preset `desktop` afterward.

- [ ] **Step 10: Commit**

```bash
git add src/components/marketing/marketing-footer.tsx scripts/smoke-marketing-footer.ts scripts/run-smoke.ts \
  src/components/landing/landing-scenes.tsx "src/app/(marketing)/pricing/page.tsx" "src/app/(marketing)/interest/page.tsx" \
  src/components/landing/landing-auth-controls.tsx
git commit -m "Give phones thumb-sized targets on the marketing pages

One MarketingFooter replaces three pasted copies: 44px links, a row that
wraps instead of breaking \"Interest list\" in two at 320px, and a footer
nav landmark. The header's Sign in / Get Started, the only calls to
action on a phone until the finale, get a 44px hit area without
changing the pill.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Acceptance pass on real WebKit, then open PR B

**Files:** none. This task verifies and ships.

**Interfaces:**
- Consumes: Task 2's computed blur and Task 3's footer and hit areas, all on this branch.
- Produces: PR B.

The iOS Simulator is real Safari: `svh` units, the collapsing toolbar, and the short 667pt iPhone SE viewport, none of which Chromium emulation reproduces. It **cannot** show the glass fix, because WebKit honors the prefixed property, and it isn't a frame-rate measurement.

- [ ] **Step 1: Boot the simulators and open the page**

```bash
SE=E31E42A9-E213-415A-B1EA-49DC765B365C    # iPhone SE (3rd generation), 375×667 pt
PRO=277EF82F-90A7-4F37-9636-87B37C036836   # iPhone 16 Pro
SHOTS=/private/tmp/claude-501/landing-accept && mkdir -p "$SHOTS"
xcrun simctl boot "$SE"; open -a Simulator
xcrun simctl openurl "$SE" "http://localhost:$PORT/?r=$(date +%s)"   # PORT = the preview server's port
sleep 8 && xcrun simctl io "$SE" screenshot "$SHOTS/se-01-hero.png" && sips -Z 1000 "$SHOTS/se-01-hero.png" >/dev/null
```

Scroll with the iOS Simulator tool's `swipe` (start more than 4pt from any edge; a vertical swipe of about 400pt ≈ one screen). After each swipe, `sleep 2` and capture with `xcrun simctl io "$SE" screenshot ...`. The simulator tool's own screenshot can wedge after a device swap; `simctl io` keeps working. Safari won't reload an identical URL, so keep the `?r=` cache-buster.

- [ ] **Step 2: Check each frame against these pass criteria (iPhone SE, portrait)**

1. **Hero:** "Orbit", "Keep your connections in Orbit.", and the full body sentence are visible above the solar system; the sun and planets are textured spheres, not empty circles.
2. **Mid-pin** (1–2 swipes): the hero copy has faded out and the system is flattening. A horizontal swipe does not move the page.
3. **End of pin** (about 3 swipes): the claim "The people who can get you hired are already drifting." and all three ring labels (Inner circle, Still warm, Drifting) are visible at once, with "Drifting" not hidden under Safari's bottom toolbar. **This is the frame most likely to fail**: the SE's short viewport is exactly where `HeroPin`'s fit math (`BOTTOM_PAD = 56`, `CAM_SCALE_MIN = 0.42`) is tightest.
4. **Constellation, follow-ups, how-it-works, features:** no heading collides with the header in a way that hides content.
5. **Footer:** links sit in at most two rows, and "Interest list" is on one line.

- [ ] **Step 3: Landscape and a second device**

Rotate the SE to landscape (in Simulator: `osascript -e 'tell application "System Events" to keystroke (ASCII character 28) using command down'`), reload with a fresh `?r=`, and capture the hero. `simctl io` captures in native orientation, so read the file with `sips -r 270`. Pass: the hero copy is readable, and a horizontal swipe does not move the page. Then boot `$PRO` and repeat criteria 1 and 3 in portrait.

- [ ] **Step 4: Triage**

If criterion 3 or landscape fails, **don't tune `HeroPin` in this PR**. It is unrelated to Tasks 2–3, and its fit math is shared across every width. Attach the screenshot to the PR as a known issue and open a follow-up. Any failure of criteria 1, 2, 4, or 5 blocks the PR: fix it on this branch and rerun the step.

- [ ] **Step 5: Open PR B**

```bash
git push -u origin claude/orbit-mobile-flow-testing-63d27f
gh pr create --title "Landing on phones: restore the glass blur, thumb-sized targets" --body "$(cat <<'EOF'
## Why

A mobile audit of the landing page (375×812, 320×720, re-verified against production on 2026-09-10) found:

- **Page text ghosts through the fixed header** in Chrome, Android, Edge and Firefox. Production CSS ships `.landing-header-glass`, `.liquid-glass` and `.landing-glass` with only `-webkit-backdrop-filter` (Lightning CSS drops the standard property when the twin is hand-written), so `backdropFilter` computes to `none` everywhere except Safari.
- **The only phone CTAs are 36px tall** (header Sign in / Get Started; the hero hides its pair below md on purpose), and **footer links are 20px tall**, with "Interest list" wrapping in two at 320px. The footer was pasted into three pages.

The blank-planets bug (P0) found in the same audit ships separately in #134.

## What changed

1. **Glass blur restored:** cherry-picks `aec733b` from #154 unchanged (same content, so #154 still merges cleanly), and adds `scripts/smoke-backdrop-filter.ts`, which fails on any hand-written `-webkit-backdrop-filter` declaration or a glass class without a standard blur.
2. **`MarketingFooter`** replaces three copies: 44px links, a wrapping row, and a `nav aria-label="Footer"` landmark. The header buttons get a 44px `::after` hit area; the visible pills are unchanged. Guarded by `scripts/smoke-marketing-footer.ts`.

## Verification

- `smoke-backdrop-filter` and `smoke-marketing-footer` fail on main and pass here; `test:check`, `typecheck`, and `lint` (0 errors) are clean.
- Chromium (375 and 320): `.landing-header-glass` computes to `blur(24px) saturate(1.4)` (was `none`); header targets hit-test 4px above and below the pill; every footer link is 44px; no horizontal scroll.
- iOS Simulator (iPhone SE 3rd gen portrait and landscape, iPhone 16 Pro): see screenshots. WebKit honors the prefix, so the glass fix is verified in Chromium, not here.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Attach the SE portrait frames (hero, end of pin, footer) to the PR body.

- [ ] **Step 6: After merge, verify production**

```bash
gh api "repos/{owner}/{repo}/deployments?environment=Production&per_page=1" --jq '.[0].sha[0:7]'; git rev-parse --short origin/main
B=https://orbit.jasonpereira.live
for c in $(curl -s "$B/" | command grep -oE '/_next/static/[^"]+\.css' | sort -u); do curl -s "$B$c"; done | python3 -c '
import re, sys
s = sys.stdin.read()
for sel in [".landing-header-glass{", ".liquid-glass{", ".landing-glass{"]:
    i = s.find(sel); body = s[i:s.find("}", i)] if i >= 0 else ""
    print(sel, re.findall(r"(?:-webkit-)?backdrop-filter:[^;}]*", body))'
```

Expected: the SHAs match, and each rule lists a standard `backdrop-filter:blur(...)` entry. On 2026-09-10 each listed only the `-webkit-` form.

---

### Task 5: The page ends at its footer, and fragment links clear the header (added during execution)

> **Amended in review:** the shipped selectors are scoped to `.landing-root #groups` … `.landing-root #cta`, and the guard also fails on any bare `#id` scroll-margin rule. The dashboard's reminders card carries `id="reminders"` with its own `scroll-mt-8`, and a bare `#reminders` rule overrode it (an id selector outranks a class). The code blocks below show the original, unscoped version.

Found by Task 4's real-Safari pass on the iPhone SE (375×667), and measured in Chromium and on production:

- **An empty band after the footer.** The landing footer's decorative glow is a 560px circle centered on a ~200px footer, so it hangs about 280px below the footer's midpoint. `.landing-root` clips only the x axis, so that overhang extends the scrollable page. Production at 375×667: `document.scrollHeight` 8132 vs the landing root's bottom at 7950, a **182px** empty band where the lighter app starfield shows through (158px on this branch, because Task 3's footer is taller).
- **Fragment links land under the header.** `globals.css` gives `scroll-margin-top: 6rem` to `#landing-groups` … `#landing-cta`, ids that don't exist; the real ids in `LANDING_SECTIONS` are `groups`, `reminders`, `how`, `features` and `cta`. In SE Safari, `/#features` lands with the heading's first line under the header pill. Section-nav taps are unaffected, because they subtract `LANDING_HEADER_SCROLL_OFFSET` (96px, which equals 6rem) in JS.

**Files:**
- Create: `scripts/smoke-landing-anchors.ts`
- Modify: `scripts/run-smoke.ts` (`MANIFEST`)
- Modify: `src/components/landing/landing-page.tsx:29-30`
- Modify: `src/app/globals.css:1284-1290`

**Interfaces:**
- Consumes: `LANDING_HEADER_SCROLL_OFFSET` and `LANDING_SECTIONS` from `src/components/landing/landing-sections.ts` (a pure module).
- Produces: nothing other tasks import.

- [ ] **Step 1: Write the failing guard**

Create `scripts/smoke-landing-anchors.ts`:

```ts
/**
 * The landing page's scroll geometry, pinned where no browser is needed.
 *
 * 1. A fragment link (/#how, /#features, a shared URL) must land BELOW the fixed header.
 *    The section nav subtracts LANDING_HEADER_SCROLL_OFFSET in JS, but a typed or shared
 *    link only has CSS scroll-margin to go on, and that rule used to target ids that never
 *    existed, so every heading landed under the header.
 * 2. The page must end at its footer. The footer's glow is a circle far taller than the
 *    footer, centered on it; without vertical clipping it hung below the page and added an
 *    empty band after the footer on short phones.
 */
import { readFileSync } from "node:fs";
import {
  LANDING_HEADER_SCROLL_OFFSET,
  LANDING_SECTIONS,
} from "../src/components/landing/landing-sections";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function main() {
  const css = readFileSync("src/app/globals.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
  // Innermost rules only, as { selectors, body }: rules nested in @media still match.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(",").map((sel) => sel.trim()),
    body: m[2],
  }));
  const marginRules = rules.filter((r) => /scroll-margin-top\s*:/.test(r.body));

  console.log("Fragment links clear the fixed header:");
  for (const { id } of LANDING_SECTIONS) {
    const rule = marginRules.find((r) => r.selectors.includes(`#${id}`));
    const rem = rule ? /scroll-margin-top\s*:\s*([\d.]+)rem/.exec(rule.body)?.[1] : undefined;
    check(`#${id} has a scroll-margin-top`, Boolean(rule));
    check(
      `#${id}'s margin equals LANDING_HEADER_SCROLL_OFFSET (${LANDING_HEADER_SCROLL_OFFSET}px)`,
      rem !== undefined && Number(rem) * 16 === LANDING_HEADER_SCROLL_OFFSET,
      rem ? `${rem}rem` : "no rem value"
    );
  }
  const sectionIds = new Set<string>(LANDING_SECTIONS.map((s) => `#${s.id}`));
  const orphans = marginRules
    .flatMap((r) => r.selectors)
    .filter((sel) => /^#[\w-]+$/.test(sel) && !sectionIds.has(sel));
  check("no scroll-margin rule targets an id outside LANDING_SECTIONS", orphans.length === 0, orphans.join(", "));

  console.log("\nThe page ends at its footer:");
  const page = readFileSync("src/components/landing/landing-page.tsx", "utf8");
  const root = /className="(landing-root[^"]*)"/.exec(page)?.[1] ?? "";
  const classes = root.split(/\s+/);
  check(
    "landing-root clips overflow on both axes",
    classes.includes("overflow-clip") && !classes.includes("overflow-x-clip"),
    root || "landing-root not found"
  );

  if (failures > 0) {
    console.error(`\nFAILED: ${failures} check(s).`);
    process.exit(1);
  }
  console.log("\nFragment links clear the header, and the page ends at its footer.");
  process.exit(0);
}

main();
```

- [ ] **Step 2: Register it and watch it fail**

In `scripts/run-smoke.ts`, in `MANIFEST`'s `pure` block, insert between `"smoke-import-progress-card": "pure",` and `"smoke-lifetime-pricing": "pure",`:

```ts
  "smoke-landing-anchors": "pure",
```

```bash
npx tsx scripts/smoke-landing-anchors.ts; echo "exit=$?"
```

Expected: all ten `#<id>` checks `FAIL` (no rule targets the real ids); `FAIL no scroll-margin rule targets an id outside LANDING_SECTIONS — #landing-groups, #landing-reminders, #landing-how, #landing-features, #landing-cta`; `FAIL landing-root clips overflow on both axes — landing-root relative overflow-x-clip …`; `exit=1`.

- [ ] **Step 3: Point the scroll margin at the real ids**

In `src/app/globals.css`, replace (lines 1284–1290):

```css
#landing-groups,
#landing-reminders,
#landing-how,
#landing-features,
#landing-cta {
  scroll-margin-top: 6rem;
}
```

with:

```css
#groups,
#reminders,
#how,
#features,
#cta {
  scroll-margin-top: 6rem;
}
```

Leave the comment immediately above the block (if any) as it is, unless it names the old ids. If it does, update those names to match.

- [ ] **Step 4: Clip the landing root on both axes**

In `src/components/landing/landing-page.tsx`, replace lines 29–30:

```tsx
  return (
    <div className="landing-root relative overflow-x-clip bg-[#03050c] text-[#e8f3f1]">
```

with:

```tsx
  // Clipped on both axes: the footer's glow is taller than the footer and would otherwise
  // extend the page into an empty band below it. `clip`, unlike `hidden`, creates no scroll
  // container, so the sticky frames inside keep working.
  return (
    <div className="landing-root relative overflow-clip bg-[#03050c] text-[#e8f3f1]">
```

Only the landing page changes. `/pricing` and `/interest` have their own `landing-root` without the glow, so leave them alone.

- [ ] **Step 5: Run everything**

```bash
npx tsx scripts/smoke-landing-anchors.ts; echo "exit=$?"
npm run test:check
npm run typecheck
npm run lint 2>&1 | tail -3
```

Expected: every check `ok`, then `Fragment links clear the header, and the page ends at its footer.` and `exit=0`; `test:check` passes; typecheck clean; lint `0 errors`.

- [ ] **Step 6: Measure (controller)**

At 375×667 in the Chromium pane (with `.landing-scene` forced to `content-visibility: visible` for measurement), `document.documentElement.scrollHeight` must equal the landing root's bottom (it was 158px taller on this branch, 182px on production). Loading `/#features` must put the `#features` heading below the header pill's bottom edge (74px). Then re-check both in iPhone SE Safari.

- [ ] **Step 7: Commit**

```bash
git add scripts/smoke-landing-anchors.ts scripts/run-smoke.ts src/app/globals.css src/components/landing/landing-page.tsx
git commit -m "End the landing page at its footer, and land fragment links below the header

The footer glow overhung the page by 158-182px on short phones, adding an
empty band after the footer; the landing root now clips both axes. The
header's scroll margin targeted #landing-* ids that never existed, so
/#features and friends landed under the header; it now names the real
LANDING_SECTIONS ids, and a guard keeps the two in step.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

## Optional follow-up: fragment links land under the header (promoted to Task 5)

`globals.css:1288-1294` gives `scroll-margin-top: 6rem` to `#landing-groups`, `#landing-reminders`, `#landing-how`, `#landing-features` and `#landing-cta`. **None of those ids exist.** The real ids (`src/components/landing/landing-sections.ts`) are `groups`, `reminders`, `how`, `features` and `cta`. Section-nav taps are unaffected because `scrollToSection` subtracts `LANDING_HEADER_SCROLL_OFFSET` (96px, which equals 6rem) in JS. A direct or shared link such as `/#how` gets no margin, though, and lands with its heading under the fixed header. Nothing in the app links to these fragments today, so this is low-impact.

Fix: replace the selector list with the real ids:

```css
#groups,
#reminders,
#how,
#features,
#cta {
  scroll-margin-top: 6rem;
}
```

Test (pane, `mobile` preset): load `/#how`, wait 1s, and run `document.getElementById('how').getBoundingClientRect().top`. It should be ≥ 64 (below the 12px-offset, 52px header pill); on main it is ≈ 0.

## Out of scope (and why)

- **Tokenizing the landing palette** (127 hard-coded hex values, 11 distinct colors, across `src/components/landing/*.tsx`). The landing page is a deliberately fixed dark world that doesn't follow the app theme, so tokens would change nothing a visitor sees. Revisit if the landing page ever gets a light theme.
- **Frame rate on a real phone.** Neither the pane nor the Simulator measures GPU cost. Jason can check on his own iPhone with Safari Web Inspector → Timelines while scrolling the hero pin. The blur restored in Task 2 adds GPU work on Chromium phones, which is the intended design, but it's worth a look on a mid-range Android.
- **A hero CTA on phones.** It's hidden below `md` by design (the header carries the same buttons). Task 3 makes the header pair a proper target instead of adding a duplicate.
