import { test, expect } from "@playwright/test";
import { ensureOnboarded } from "./helpers";

// Cosmo PR 2: the orb in the corner of every page. Localhost always previews `feature.cosmo`.
const sessionId = "33333333-3333-4333-8333-333333333333";
const threadId = "44444444-4444-4444-8444-444444444444";

test("Cosmo can be moved, steps out of the way, stays usable over a dialog and tucks away on a phone", async ({ page }) => {
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  if (new URL(page.url()).pathname.startsWith("/onboarding")) await ensureOnboarded(page);
  await page.route("**/api/voice", (route) =>
    route.fulfill({ json: { enabled: true, provider: "deepgram", fallbackProvider: null, revision: "cosmo-test" } }),
  );
  await page.goto("/contacts", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.removeItem("orbit:cosmo-slot"));
  await page.reload({ waitUntil: "domcontentloaded" });
  const orb = page.getByRole("button", { name: "Talk to Cosmo" });
  const column = page.locator("[data-cosmo-slot]");
  await expect(orb).toBeVisible();
  await expect(column).toHaveAttribute("data-cosmo-slot", "bottom-right");

  // Drag it to the top left: it snaps there, and that is home on this device.
  const start = (await orb.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(400, 200, { steps: 12 });
  await page.mouse.move(380, 150, { steps: 4 });
  await page.mouse.up();
  await expect(column).toHaveAttribute("data-cosmo-slot", "top-left");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("orbit:cosmo-slot"))).toBe("top-left");
  await expect(page.getByRole("region", { name: "Cosmo" })).toHaveCount(0); // a drag never presses the orb
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(column).toHaveAttribute("data-cosmo-slot", "top-left");
  const left = (await orb.boundingBox())!;
  const sidebar = (await page.locator("[data-app-sidebar]").boundingBox())!;
  expect(left.x).toBeGreaterThan(sidebar.x + sidebar.width); // beside the sidebar, never on it

  // Arrow keys move it too.
  await orb.focus();
  await page.keyboard.press("ArrowRight");
  await expect(column).toHaveAttribute("data-cosmo-slot", "top-right");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(column).toHaveAttribute("data-cosmo-slot", "bottom-right");
  await page.mouse.move(10, 10); // off Cosmo, so it may move on its own again

  // Something marked to avoid lands on its corner: it steps aside, and comes back after.
  await page.evaluate(() => {
    const block = document.createElement("div");
    block.id = "cosmo-obstacle";
    block.dataset.cosmoAvoid = "";
    Object.assign(block.style, { position: "fixed", right: "0", bottom: "0", width: "320px", height: "200px" });
    document.body.append(block);
  });
  await expect(column).not.toHaveAttribute("data-cosmo-slot", "bottom-right");
  await page.evaluate(() => document.getElementById("cosmo-obstacle")?.remove());
  await expect(column).toHaveAttribute("data-cosmo-slot", "bottom-right");

  // With a dialog open Cosmo is still on top, reachable and not hidden from assistive tech.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  await expect(page.getByRole("dialog")).toBeVisible();
  // Measured each time: it may still be gliding aside from the dialog.
  await expect
    .poll(() =>
      orb.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return `${hit?.getAttribute("aria-label") ?? hit?.tagName ?? "nothing"} @ ${el.closest("[data-cosmo-slot]")?.getAttribute("data-cosmo-slot")}`;
      }),
    )
    .toMatch(/^Talk to Cosmo @/);
  expect(await orb.evaluate((el) => el.closest('[aria-hidden="true"]') === null)).toBe(true);
  await page.keyboard.press("Escape");
  // Closed for good: it hands focus back on the way out, which would steal the field's below.
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // On a phone it sits above the bottom nav, and tucks into an edge tab while you type.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(orb).toBeVisible();
  const phone = (await orb.boundingBox())!;
  // Clear of the bottom nav's pill, whose top is the top of its tallest item (the lifted Capture).
  const navTop = Math.min(
    ...(await page.locator('a[href="/capture"]:visible, a[href="/contacts"]:visible').evaluateAll((els) =>
      els.map((el) => el.closest("nav")?.getBoundingClientRect().top ?? 9999),
    )),
  );
  expect(phone.y + phone.height).toBeLessThanOrEqual(navTop);
  await page.getByPlaceholder(/search contacts/i).first().focus();
  await expect(page.getByRole("button", { name: "Show Cosmo" })).toBeVisible();
  await expect(orb).toHaveCount(0);
  await page.getByRole("button", { name: "Show Cosmo" }).click();
  await expect(orb).toBeVisible();
  const shot = test.info().outputPath("cosmo-phone.png");
  await page.screenshot({ path: shot });
  await test.info().attach("cosmo phone", { path: shot, contentType: "image/png" });
});

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
