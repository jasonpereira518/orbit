import { expect, test, type Page } from "@playwright/test";

/**
 * Plan colors in a real browser, both themes (pricing v2): every plan surface reads its accent
 * from a `[data-plan]` scope, so a probe inside each scope must resolve to that plan's token —
 * Pro blue, Max the existing gold, Lifetime silver, Free teal-gray. `smoke-tier-contrast`
 * holds the VALUES to WCAG AA; this holds the WIRING (tokens, scopes, the compiled utility).
 */
const EXPECTED = {
  light: { free: "rgb(61, 91, 88)", orbit: "rgb(47, 104, 176)", max: "rgb(138, 100, 35)", lifetime: "rgb(86, 97, 110)" },
  dark: { free: "rgb(169, 195, 190)", orbit: "rgb(89, 157, 231)", max: "rgb(242, 193, 78)", lifetime: "rgb(197, 204, 214)" },
} as const;

async function accents(page: Page) {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const plan of ["free", "orbit", "max", "lifetime"]) {
      const scope = document.createElement("div");
      scope.setAttribute("data-plan", plan);
      const probe = document.createElement("span");
      probe.className = "text-tier-accent";
      probe.textContent = plan;
      scope.append(probe);
      document.body.append(scope);
      out[plan] = getComputedStyle(probe).color;
      scope.remove();
    }
    return { accents: out, dark: document.documentElement.classList.contains("dark") };
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`each plan scope resolves to its own color — ${theme}`, async ({ page }) => {
    await page.addInitScript((t) => {
      try {
        localStorage.setItem("theme", t);
      } catch {}
    }, theme);
    await page.goto("/contact");
    await expect.poll(async () => (await accents(page)).dark).toBe(theme === "dark");
    expect((await accents(page)).accents).toEqual(EXPECTED[theme]);
  });
}

test("the pricing page paints Pro blue and Max gold on the night sky", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByRole("heading", { name: "Orbit Max", exact: true })).toBeVisible();
  const colors = await page.evaluate(() => {
    const seen = new Set<string>();
    for (const el of document.querySelectorAll("main *")) seen.add(getComputedStyle(el).color);
    return [...seen];
  });
  expect(colors).toContain("rgb(89, 157, 231)");
  expect(colors).toContain("rgb(242, 193, 78)");
});
