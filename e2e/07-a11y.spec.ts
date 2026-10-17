import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createContact, ensureOnboarded } from "./helpers";

/**
 * Accessibility and layout gate for every page (see A11Y_RESPONSIVE_AUDIT.md).
 *
 * Each route, at a phone width and a laptop width:
 *   - axe-core with the WCAG 2.0/2.1/2.2 A and AA rules; any `serious` or `critical`
 *     violation fails the build. `moderate`/`minor` findings are printed, not failed.
 *   - no horizontal overflow, of the document or of the app's own scroll column.
 * Then the flows the audit found broken, held in place:
 *   - every app page has its own title (how a screen reader hears a navigation at all),
 *   - the first Tab reaches "Skip to content",
 *   - a dialog fits a 360x640 phone, with its submit button reachable,
 *   - Chat still has a usable composer at 200% zoom (1280x900 shown at 640x450).
 *
 * Reduced motion is on throughout: scroll-reveal fades are otherwise caught mid-animation
 * and read as low-contrast text.
 */
test.use({ reducedMotion: "reduce" });

const MARKETING = ["/", "/interest", "/privacy", "/terms", "/contact", "/connect", "/pricing", "/upgrade"];
const APP = [
  "/dashboard",
  "/contacts",
  "/contacts/new",
  "/contacts/duplicates",
  "/capture",
  "/chat",
  "/graph",
  "/meetings",
  "/reminders",
  "/recruiters",
  "/recruiters/new",
  "/recruiters/compose",
  "/knowledge",
  "/imports",
  "/radar",
  "/events",
  "/settings",
];
const ADMIN = ["/admin", "/admin/users", "/admin/billing/costs", "/admin/growth", "/admin/health"];
const WIDTHS = [
  { name: "phone", width: 360, height: 780, touch: true },
  { name: "laptop", width: 1280, height: 900, touch: false },
] as const;
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const BLOCKING = new Set(["serious", "critical"]);

/** Settled enough to judge: hydrated, data in, skeletons gone. */
async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await expect(page.locator('[data-slot="skeleton"]').first()).toBeHidden({ timeout: 30_000 }).catch(() => {});
}

async function audit(page: Page, route: string) {
  const results = await new AxeBuilder({ page })
    .withTags(WCAG)
    // The Next.js dev overlay is not the app.
    .exclude("nextjs-portal")
    .analyze();
  const blocking = results.violations.filter((v) => BLOCKING.has(v.impact ?? ""));
  const advisory = results.violations.filter((v) => !BLOCKING.has(v.impact ?? ""));
  for (const v of advisory) console.log(`  [${v.impact}] ${route} ${v.id}: ${v.nodes.length} node(s)`);
  const report = blocking
    .map(
      (v) =>
        `${v.impact} ${v.id} — ${v.help}\n` +
        v.nodes
          .slice(0, 5)
          .map((n) => `    ${n.target.join(" ")}\n      ${(n.failureSummary ?? "").split("\n").join("\n      ")}`)
          .join("\n")
    )
    .join("\n");
  expect(blocking, `serious/critical axe violations on ${route}:\n${report}`).toEqual([]);
}

async function horizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const column = document.getElementById("app-main-scroll");
    return {
      document: doc.scrollWidth - doc.clientWidth,
      column: column ? column.scrollWidth - column.clientWidth : 0,
    };
  });
}

let contactPath = "";

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await ensureOnboarded(page);
  await createContact(page, "Amara Okonkwo-Lindqvist");
  contactPath = new URL(page.url()).pathname;
  await page.close();
});

for (const size of WIDTHS) {
  test.describe(`${size.name} (${size.width}px)`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, hasTouch: size.touch, isMobile: size.touch });

    for (const route of [...MARKETING, ...APP, "contact profile", ...ADMIN]) {
      test(`axe + overflow: ${route}`, async ({ page }) => {
        const path = route === "contact profile" ? contactPath : route;
        await page.goto(path);
        await settle(page);
        await audit(page, path);
        expect(await horizontalOverflow(page), `horizontal overflow on ${path}`).toEqual({ document: 0, column: 0 });
      });
    }
  });
}

test("every app page has its own title", async ({ page }) => {
  const titles = new Map<string, string>();
  for (const route of [...APP, contactPath]) {
    await page.goto(route);
    await expect.poll(() => page.title()).not.toBe("");
    titles.set(route, await page.title());
  }
  const generic = [...titles].filter(([, t]) => t === "Orbit — Personal Networking Tracker");
  expect(generic, "pages still on the default title").toEqual([]);
  const seen = new Map<string, string>();
  for (const [route, title] of titles) {
    expect(seen.get(title), `${route} shares its title "${title}" with ${seen.get(title)}`).toBeUndefined();
    seen.set(title, route);
  }
});

test("the first Tab reaches the skip link, and it moves focus to the content", async ({ page }) => {
  for (const route of ["/", "/dashboard"]) {
    await page.goto(route);
    await settle(page);
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest("main")))
      .toBe(true);
  }
});

test.describe("small phone (360x640)", () => {
  test.use({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true });

  test("a dialog fits the screen and its submit button can be reached", async ({ page }) => {
    await page.goto("/reminders");
    await settle(page);
    await page.getByRole("button", { name: /new reminder/i }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box, "dialog has a box").not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(640);
    const save = dialog.getByRole("button", { name: /^(save|add|create)/i }).last();
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
  });
});

test.describe("200% zoom (640x450)", () => {
  test.use({ viewport: { width: 640, height: 450 } });

  test("Chat keeps a usable composer", async ({ page }) => {
    await page.goto("/chat");
    await settle(page);
    const composer = page.getByRole("textbox", { name: /ask/i }).first();
    await composer.scrollIntoViewIfNeeded();
    await expect(composer).toBeInViewport();
    expect((await composer.boundingBox())!.height).toBeGreaterThan(20);
  });
});
