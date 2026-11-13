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
  // Clear of the bottom nav's pill, whose top is the top of its tallest item (the lifted Capture).
  // Polled: after the resize the orb may still be settling into its new corner.
  await expect
    .poll(async () => {
      const phone = (await orb.boundingBox())!;
      const navTop = Math.min(
        ...(await page.locator('a[href="/capture"]:visible, a[href="/contacts"]:visible').evaluateAll((els) =>
          els.map((el) => el.closest("nav")?.getBoundingClientRect().top ?? 9999),
        )),
      );
      return phone.y + phone.height <= navTop;
    })
    .toBe(true);
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
  const startNudges: Array<string | undefined> = [];
  const startScreens: Array<{ page: string | null; targets: string[] } | undefined> = [];
  const spoken: Array<{ action: string }> = [];
  const draftMessage = "55555555-5555-4555-8555-555555555555";
  const adaId = "66666666-6666-4666-8666-666666666666";
  const sendId = "77777777-7777-4777-8777-777777777777";
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
      startNudges.push(body.nudge);
      startScreens.push(body.screen);
      return route.fulfill({
        json: {
          sessionId,
          threadId,
          // The second call has under a minute of the month's Cosmo time left.
          expiresAt: new Date(Date.now() + (starts.length === 2 ? 45_000 : 600000)).toISOString(),
          endsEarly: starts.length === 2,
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
    if (body.action === "tool" && body.tool === "draft_email")
      return route.fulfill({
        json: {
          result: JSON.stringify({ untrusted_crm_data: { proposed: true } }),
          proposal: {
            messageId: draftMessage,
            action: {
              id: "draft-1",
              args: { tool: "draft_email", input: { contactId: adaId, body: "Thanks for the intro" } },
              preview: "Email Ada: “Thanks for the intro” — you review and send it",
              status: "proposed",
              tier: "confirm",
            },
          },
        },
      });
    if (body.action === "confirm" || body.action === "undo_send") {
      spoken.push(body);
      return route.fulfill({
        json:
          body.action === "confirm"
            ? { outcome: "sent", sendId: sendId, sendAt: new Date(Date.now() + 10_000).toISOString(), to: "ada@example.com" }
            : { result: "canceled" },
      });
    }
    if (body.action === "connected") connected++;
    if (body.action === "end") ends++;
    return route.fulfill({ json: { ok: true } });
  });
  let socket: { send(message: string | Buffer): void } | undefined;
  const frames: Array<Record<string, unknown>> = [];
  await page.routeWebSocket("wss://agent.deepgram.com/**", (ws) => {
    sockets++;
    socket = ws;
    // One handler: a second onMessage replaces the first.
    ws.onMessage((raw) => {
      if (typeof raw !== "string") return;
      const message = JSON.parse(raw);
      frames.push(message);
      if (message.type === "Settings") ws.send(JSON.stringify({ type: "SettingsApplied" }));
    });
    ws.send(JSON.stringify({ type: "Welcome", request_id: "cosmo-test" }));
  });
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.removeItem("orbit:cosmo-thread");
    localStorage.removeItem("orbit:cosmo-nudges");
  });

  const orb = page.getByRole("button", { name: "Talk to Cosmo" });
  await expect(orb).toBeVisible();
  const cornerHeight = () =>
    page.evaluate(() => parseFloat(document.documentElement.style.getPropertyValue("--orbit-cosmo-height") || "0"));
  // Hovered, it perks up: the halo comes on (and the call's code starts loading).
  await orb.hover();
  await expect.poll(() => orb.evaluate((el) => getComputedStyle(el, "::after").opacity)).toBe("1");
  await expect.poll(cornerHeight).toBeGreaterThan(40);

  // Speaking up: whatever this account's pulse holds, the orb shows at most one nudge, and a
  // call started from the orb names that nudge (only its id; the server rebuilds the words).
  const chip = page.locator(".cosmo-chip");
  await page.waitForTimeout(1500); // the pulse's first read
  expect(await chip.count()).toBeLessThanOrEqual(1);
  const shownNudge = (await chip.count())
    ? await page.locator(".cosmo-idle").getAttribute("data-nudge")
    : null;
  if (shownNudge) {
    // A dismissed nudge stays gone for the day on this device.
    const label = await chip.getByRole("button").first().textContent();
    await chip.getByRole("button", { name: /^Dismiss:/ }).click();
    await expect(page.getByRole("button", { name: `Dismiss: ${label}` })).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("orbit:cosmo-nudges") ?? "{}").ids?.length)).toBe(1);
  }
  const nudgeAtClick = (await chip.count()) ? await page.locator(".cosmo-idle").getAttribute("data-nudge") : null;

  await orb.click();
  const cosmo = page.getByRole("region", { name: "Cosmo", exact: true });
  await expect(cosmo.getByRole("button", { name: "Mute", exact: true })).toBeVisible();
  await expect.poll(() => connected).toBe(1);
  await expect(cosmo.getByText("Under a minute of Cosmo left for now")).toHaveCount(0);
  expect(starts[0]).toEqual({ threadId: undefined, freshIfMissing: true });
  if (nudgeAtClick) expect(startNudges[0]).toMatch(/^(meeting:|due$|debrief:|radar$)/);
  else expect(startNudges[0]).toBeUndefined();
  // The call starts knowing where you are: the page key and registered control ids, nothing else.
  expect(startScreens[0]?.page).toBe("dashboard");
  expect(startScreens[0]?.targets.every((id) => /^[a-z]+\.[a-z-]+$/.test(id))).toBe(true);
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("orbit:cosmo-thread") ?? "{}").id))
    .toBe(threadId);

  // Captions: off by default, on from the bar, and they keep pace with the voice.
  const send = (message: unknown) => socket!.send(JSON.stringify(message));
  const speech = (seconds: number) => {
    const audio = Buffer.alloc(seconds * 48000);
    for (let i = 0; i < seconds * 24000; i++) audio.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 220) / 24000) * 6000), i * 2);
    return audio;
  };
  const caption = page.locator("[data-cosmo-caption] p:not(.truncate)");
  const captionWords = () => caption.textContent({ timeout: 1000 }).then((t) => (t ?? "").replace("…", "").trim().split(/\s+/).filter(Boolean).length).catch(() => 0);
  const ccButton = cosmo.getByRole("button", { name: "Captions" });
  await expect(ccButton).toHaveAttribute("aria-pressed", "false");
  await ccButton.click();
  await expect(ccButton).toHaveAttribute("aria-pressed", "true");
  const line = "Coffee with Ada is at three tomorrow at the usual place near her office";
  send({ type: "ConversationText", role: "assistant", content: line });
  socket!.send(speech(3));
  send({ type: "AgentAudioDone" });
  const seen: number[] = [];
  for (let i = 0; i < 40 && seen.at(-1) !== 14; i++) {
    seen.push(await captionWords());
    await page.waitForTimeout(100);
  }
  expect(seen.some((n) => n > 0 && n < 14), `words appear as it speaks, not all at once: ${seen.join(",")}`).toBe(true);
  await expect.poll(captionWords).toBe(14);

  // Cut off mid-line: the words said so far stay, marked with an ellipsis, and stop growing.
  send({ type: "ConversationText", role: "assistant", content: "Before that you might want to read her latest paper on compilers and ask her about it" });
  socket!.send(speech(5));
  await expect.poll(async () => (await caption.textContent())?.startsWith("Before")).toBe(true);
  send({ type: "UserStartedSpeaking" });
  await expect(caption).toHaveText(/…$/);
  const cutAt = await captionWords();
  await page.waitForTimeout(600);
  expect(await captionWords()).toBe(cutAt);
  expect(cutAt).toBeLessThan(17);

  // The voice can switch them too.
  send({
    type: "FunctionCallRequest",
    functions: [{ id: "cc_off", name: "orbit_tool", client_side: true, arguments: JSON.stringify({ tool: "set_captions", input: JSON.stringify({ on: false }) }) }],
  });
  await expect(ccButton).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-cosmo-caption]")).toHaveCount(0);
  await expect.poll(() => frames.find((f) => f.type === "FunctionCallResponse" && f.id === "cc_off")?.content).toContain("off");

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
  // It can look at the screen: this page, in Orbit's own labels.
  const ask = (id: string, tool: string, input: unknown) =>
    send({
      type: "FunctionCallRequest",
      functions: [{ id, name: "orbit_tool", client_side: true, arguments: JSON.stringify({ tool, input: JSON.stringify(input) }) }],
    });
  const reply = (id: string) => frames.find((f) => f.type === "FunctionCallResponse" && f.id === id)?.content as string | undefined;
  await expect(page.locator('[data-tour="contacts.add"]').first()).toBeVisible();
  ask("look_1", "look_at_screen", {});
  await expect.poll(() => reply("look_1")).toContain("contacts page");
  expect(reply("look_1")).toContain("Add contact button");
  // Moving on: the next tool result tells it, once.
  await page.locator('a[href="/reminders"]:visible').first().click();
  await expect(page).toHaveURL(/\/reminders/);
  await expect(page.locator('[data-tour="reminders.new"]').first()).toBeVisible();
  ask("cc_on", "set_captions", { on: true });
  await expect.poll(() => reply("cc_on")).toContain("Screen now: The user is on the reminders page");
  expect(reply("cc_on")).toContain("New reminder button");
  ask("cc_off_2", "set_captions", { on: false });
  await expect.poll(() => reply("cc_off_2")).toBeTruthy();
  expect(reply("cc_off_2")).not.toContain("Screen now");
  await page.locator('a[href="/contacts"]:visible').first().click();
  await expect(page).toHaveURL(/\/contacts/);

  // Pointing: from Contacts to Reminders' "New reminder". The cursor shows the way there first,
  // follows the person's clicks, and Cosmo hears each one. It never clicks for them.
  const cursor = page.locator("[data-tour-cursor]");
  const ring = page.locator(".cosmo-ring");
  /** The cursor's tip has landed on this control. */
  const pointingAt = (target: import("@playwright/test").Locator) =>
    Promise.all([cursor.boundingBox(), target.boundingBox()]).then(([c, t]) =>
      Boolean(c && t && c.x >= t.x - 4 && c.x <= t.x + t.width + 4 && c.y >= t.y - 4 && c.y <= t.y + t.height + 4),
    );
  ask("point_bad", "point_at", { targets: ['button[aria-label="Delete"]'] });
  await expect.poll(() => reply("point_bad")).toContain("Unknown control");
  ask("point_1", "point_at", { targets: ["reminders.new"] });
  await expect.poll(() => reply("point_1")).toContain("New reminder button");
  await expect(cursor).toContainText("Cosmo");
  const navLink = page.locator('[data-app-sidebar] a[href="/reminders"]').first();
  await expect.poll(() => pointingAt(navLink)).toBe(true);
  await expect(ring).toBeVisible();
  await navLink.click();
  await expect(page).toHaveURL(/\/reminders/);
  const newReminder = page.locator('[data-tour="reminders.new"]').first();
  await expect.poll(() => pointingAt(newReminder)).toBe(true);
  // Deepgram speaks the next step as a fixed line.
  await expect.poll(() => frames.some((f) => f.type === "InjectAgentMessage" && String(f.content ?? f.message).includes("New reminder button"))).toBe(true);
  const pointShot = test.info().outputPath("cosmo-pointing.png");
  await page.screenshot({ path: pointShot });
  await test.info().attach("cosmo pointing", { path: pointShot, contentType: "image/png" });
  await newReminder.click();
  await expect(ring).toHaveCount(0);
  await page.keyboard.press("Escape"); // close the reminder popover it opened
  ask("after_point", "look_at_screen", {});
  await expect.poll(() => reply("after_point")).toContain("The user clicked the New reminder button.");
  expect(reply("after_point")).toContain("The user clicked the Reminders in the menu.");

  // Spoken confirmation: Orbit reads the email back in its own words; a "send it" said over the
  // read-back is ignored; one said after it has been heard sends; "undo" stops it.
  const injected = () => frames.filter((f) => f.type === "InjectAgentMessage").map((f) => String(f.content ?? f.message));
  ask("draft_1", "draft_email", { contactId: adaId, body: "Thanks for the intro" });
  await expect.poll(() => injected().find((line) => line.includes('Say "send it"'))).toBeTruthy();
  const readBackLine = injected().find((line) => line.includes('Say "send it"'))!;
  expect(readBackLine).toContain("Email Ada");
  send({ type: "UserStartedSpeaking" });
  send({ type: "ConversationText", role: "user", content: "send it" });
  await page.waitForTimeout(800);
  expect(spoken, "a 'send it' before the read-back finished is ignored").toHaveLength(0);
  // The read-back is spoken (its text comes back as the agent's line, then its audio plays out).
  send({ type: "ConversationText", role: "assistant", content: readBackLine });
  socket!.send(speech(1));
  send({ type: "AgentAudioDone" });
  await expect(cosmo.getByRole("status")).toHaveText("Speaking");
  await expect(cosmo.getByRole("status")).toHaveText("Listening", { timeout: 5000 });
  send({ type: "UserStartedSpeaking" });
  send({ type: "ConversationText", role: "user", content: "Send it." });
  await expect.poll(() => spoken.map((s) => s.action)).toEqual(["confirm"]);
  await expect.poll(() => injected().some((line) => line.startsWith("Sending to ada@example.com"))).toBe(true);
  send({ type: "UserStartedSpeaking" });
  send({ type: "ConversationText", role: "user", content: "undo" });
  await expect.poll(() => spoken.map((s) => s.action)).toEqual(["confirm", "undo_send"]);
  await expect.poll(() => injected().some((line) => line.startsWith("Stopped."))).toBe(true);
  const shot = test.info().outputPath("cosmo-docked.png");
  await page.screenshot({ path: shot });
  await test.info().attach("cosmo docked", { path: shot, contentType: "image/png" });

  // Saying goodbye ends the call once Cosmo's own goodbye has played.
  send({ type: "UserStartedSpeaking" });
  send({ type: "ConversationText", role: "user", content: "Bye, Cosmo." });
  send({ type: "ConversationText", role: "assistant", content: "Bye!" });
  socket!.send(speech(0.5));
  send({ type: "AgentAudioDone" });
  await expect.poll(() => ends).toBe(1);
  await expect(orb).toBeVisible();

  // The next click resumes the day's thread.
  await orb.click();
  await expect.poll(() => starts.length).toBe(2);
  expect(starts[1]).toEqual({ threadId, freshIfMissing: true });
  await expect(cosmo.getByText("Under a minute of Cosmo left for now")).toBeVisible();
  // Clicking Cosmo itself during a call ends it (the orb's canvas lets the click through).
  const liveOrb = cosmo.getByRole("button", { name: "End conversation with Cosmo" });
  await liveOrb.hover();
  await expect(page.locator(".cosmo-orb")).toHaveAttribute("data-hover", "true");
  await liveOrb.click();
  await expect.poll(() => ends).toBe(2);
});
