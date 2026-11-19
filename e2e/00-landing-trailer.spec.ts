import { expect, test } from "@playwright/test";

const ASSETS = "/landing/trailer/";
const FULL = ASSETS + "orbit-trailer-1080p.mp4";
const PREVIEW = ASSETS + "orbit-trailer-preview.mp4";

test("the logo previews silently and opens the trailer from the start", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith(ASSETS)) requested.push(path);
  });

  await page.goto("/", { waitUntil: "networkidle" });
  const logo = page.getByRole("link", { name: "Orbit, back to top" });
  const trailerButton = page.getByRole("button", { name: "Watch the Orbit trailer" });
  const preview = page.getByRole("button", { name: "Play the full Orbit trailer" });
  const dialog = page.getByRole("dialog", { name: "Orbit Trailer", exact: true });
  const player = dialog.locator("video");

  expect(requested).toEqual([]);
  await logo.hover();
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.locator("video").evaluate((video: HTMLVideoElement) => ({
    muted: video.muted,
    loop: video.loop,
    playing: !video.paused && video.currentTime > 0,
  }))).toEqual({ muted: true, loop: true, playing: true });
  expect(requested).toContain(PREVIEW);
  expect(requested).not.toContain(FULL);

  // Move across the gap before clicking. The preview stays open while hovered.
  await preview.hover();
  await expect(preview).toBeVisible();
  const range = page.waitForResponse((response) =>
    new URL(response.url()).pathname === FULL && response.status() === 206
  );
  await preview.click();
  await expect(dialog).toBeVisible();
  expect((await range).headers()["content-range"]).toMatch(/^bytes /);
  await expect(preview).toBeHidden();
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => ({
    muted: video.muted,
    playing: !video.paused && video.currentTime > 0,
  }))).toEqual({ muted: false, playing: true });
  const overlay = dialog.getByRole("heading", { name: "Orbit Trailer" }).locator("..");
  await expect(overlay).toHaveCSS("opacity", "0");
  await player.hover();
  await expect(overlay).toHaveCSS("opacity", "1");

  await expect(player.locator("track")).toHaveAttribute("srclang", "en");
  await player.evaluate((video: HTMLVideoElement) => { video.textTracks[0].mode = "showing"; });
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.textTracks[0].cues?.length))
    .toBeGreaterThan(0);

  await player.evaluate((video: HTMLVideoElement) => { video.currentTime = 20; });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(logo).toBeFocused();
  await expect.poll(() => page.locator("video[aria-label='Orbit Trailer']").evaluate(
    (video: HTMLVideoElement) => video.paused && !video.hasAttribute("src")
  )).toBe(true);

  await page.keyboard.press("Tab");
  await expect(trailerButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) =>
    !video.paused && !video.muted && video.currentTime > 0 && video.currentTime < 10
  )).toBe(true);
  await dialog.evaluate((popup) => {
    popup.addEventListener("transitionrun", (event) => {
      if (!(event instanceof TransitionEvent) || event.propertyName !== "opacity") return;
      if (!popup.hasAttribute("data-ending-style")) return;
      const video = popup.querySelector("video");
      if (video?.paused && video.hasAttribute("src")) video.dataset.pausedDuringExit = "true";
    });
  });
  await page.mouse.click(4, 4);
  await expect(page.locator("video[data-paused-during-exit]")).toHaveCount(1);
  await expect(dialog).toBeHidden();
  await expect(trailerButton).toBeFocused();
});

test("reduced motion uses a still and dismisses the preview on pointer leave", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/", { waitUntil: "networkidle" });
  const logo = page.getByRole("link", { name: "Orbit, back to top" });
  const preview = page.getByRole("button", { name: "Play the full Orbit trailer" });
  await logo.hover();
  await expect(preview).toBeVisible();
  await expect(preview.locator("video")).toHaveCount(0);
  await page.mouse.move(5, 400);
  await expect(preview).toBeHidden();

  await page.locator("#how").evaluate((section) => section.scrollIntoView({ behavior: "instant" }));
  await expect(page.locator("header a[href='#how']")).toBeVisible();
  await logo.hover();
  await expect(preview).toBeVisible();
  const logoBox = (await logo.boundingBox())!;
  const previewBox = (await preview.boundingBox())!;
  expect(previewBox.y).toBeGreaterThan(logoBox.y + logoBox.height);
  expect(Math.abs(previewBox.x - logoBox.x)).toBeLessThan(3);

  await logo.click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(preview).toBeHidden();
  await expect(page.getByRole("dialog", { name: "Orbit Trailer", exact: true })).toBeHidden();
});

test("the player offers manual playback and recovers from a failed media request", async ({ page }) => {
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    let blocked = false;
    HTMLMediaElement.prototype.play = function () {
      if (!blocked && this.src.endsWith("orbit-trailer-1080p.mp4")) {
        blocked = true;
        return Promise.reject(new DOMException("Gesture required", "NotAllowedError"));
      }
      return play.call(this);
    };
  });
  await page.route(`**${FULL}`, (route) => route.abort(), { times: 1 });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Watch the Orbit trailer" }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Orbit Trailer", exact: true });
  await dialog.getByRole("button", { name: "Play with sound" }).click();
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => dialog.locator("video").evaluate((video: HTMLVideoElement) =>
    !video.muted && !video.paused && video.currentTime > 0
  )).toBe(true);
});

test.describe("touch", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("touch users can open the full player with the separate play button", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    const trailerButton = page.getByRole("button", { name: "Watch the Orbit trailer" });
    await trailerButton.tap();
    const dialog = page.getByRole("dialog", { name: "Orbit Trailer", exact: true });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("button", { name: "Play the full Orbit trailer" })).toBeHidden();
    await dialog.getByRole("button", { name: "Close" }).tap();
    await expect(dialog).toBeHidden();
    await expect(trailerButton).toBeFocused();
  });
});
