import { test, expect } from "@playwright/test";
import { ensureOnboarded } from "./helpers";

// Cosmo PR 2: the orb in the corner of every page. Localhost always previews `feature.cosmo`.
const sessionId = "33333333-3333-4333-8333-333333333333";
const threadId = "44444444-4444-4444-8444-444444444444";

test("Cosmo starts from any page, survives navigation and resumes the day's thread", async ({ page }) => {
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  if (new URL(page.url()).pathname.startsWith("/onboarding")) await ensureOnboarded(page);
  const starts: Array<{ threadId?: string; freshIfMissing?: boolean }> = [];
  let connected = 0;
  let ends = 0;
  let sockets = 0;
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      oscillator.connect(destination);
      oscillator.start();
      return destination.stream;
    };
  });
  await page.route("**/api/voice", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { enabled: true, provider: "deepgram", fallbackProvider: null, revision: "cosmo-test" } });
    const body = route.request().postDataJSON();
    if (body.action === "start") {
      starts.push({ threadId: body.threadId, freshIfMissing: body.freshIfMissing });
      return route.fulfill({
        json: {
          sessionId,
          threadId,
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          credentials: {
            provider: "deepgram",
            accessToken: "short-lived-test-token",
            agent: {
              listen: { provider: { type: "deepgram", model: "nova-3" } },
              think: { provider: { type: "open_ai", model: "gpt-4o-mini" }, prompt: "Cosmo", functions: [] },
              speak: { provider: { type: "deepgram", model: "aura-2-asteria-en" } },
              greeting: "Hi, I’m Cosmo.",
            },
          },
        },
      });
    }
    if (body.action === "connected") connected++;
    if (body.action === "end") ends++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.routeWebSocket("wss://agent.deepgram.com/**", (ws) => {
    sockets++;
    ws.onMessage((raw) => {
      if (typeof raw === "string" && JSON.parse(raw).type === "Settings") ws.send(JSON.stringify({ type: "SettingsApplied" }));
    });
    ws.send(JSON.stringify({ type: "Welcome", request_id: "cosmo-test" }));
  });
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.removeItem("orbit:cosmo-thread"));

  const orb = page.getByRole("button", { name: "Talk to Cosmo" });
  await expect(orb).toBeVisible();
  const cornerHeight = () =>
    page.evaluate(() => parseFloat(document.documentElement.style.getPropertyValue("--orbit-cosmo-height") || "0"));
  await expect.poll(cornerHeight).toBeGreaterThan(40);

  await orb.click();
  const cosmo = page.getByRole("region", { name: "Cosmo", exact: true });
  await expect(cosmo.getByRole("button", { name: "Mute", exact: true })).toBeVisible();
  await expect.poll(() => connected).toBe(1);
  expect(starts[0]).toEqual({ threadId: undefined, freshIfMissing: true });
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("orbit:cosmo-thread") ?? "{}").id))
    .toBe(threadId);

  // Another page: same call, same socket, still docked bottom-right, and the corner it takes is
  // published so toasts and the job stack stack above it.
  await page.locator('a[href="/contacts"]:visible').first().click();
  await expect(page).toHaveURL(/\/contacts/);
  await expect(cosmo.getByRole("button", { name: "Mute", exact: true })).toBeVisible();
  expect(sockets).toBe(1);
  expect(connected).toBe(1);
  const box = (await cosmo.boundingBox())!;
  const view = page.viewportSize()!;
  expect(view.width - (box.x + box.width)).toBeLessThan(32);
  expect(view.height - (box.y + box.height)).toBeLessThan(40);
  await expect.poll(cornerHeight).toBeGreaterThanOrEqual(box.height);
  // The corner column is card-wide; only Cosmo's own controls take clicks, not the space beside them.
  const besideBar = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[aria-label="Cosmo"]') == null, {
    x: box.x + 4,
    y: box.y + box.height - 8,
  });
  expect(besideBar).toBe(true);
  const shot = test.info().outputPath("cosmo-docked.png");
  await page.screenshot({ path: shot });
  await test.info().attach("cosmo docked", { path: shot, contentType: "image/png" });

  await cosmo.getByRole("button", { name: "End conversation" }).click();
  await expect.poll(() => ends).toBe(1);
  await expect(orb).toBeVisible();

  // The next click resumes the day's thread.
  await orb.click();
  await expect.poll(() => starts.length).toBe(2);
  expect(starts[1]).toEqual({ threadId, freshIfMissing: true });
  await cosmo.getByRole("button", { name: "End conversation" }).click();
  await expect.poll(() => ends).toBe(2);
});
