import { test, expect, type WebSocketRoute } from "@playwright/test";
import { ensureOnboarded, untilHydrated } from "./helpers";
import { DEFAULT_VOICE_CONFIG } from "../src/lib/voice/config";

const id = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";

test("voice defaults off and server rejects disabled and cross-site starts", async ({
  page,
}) => {
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  if (new URL(page.url()).pathname.startsWith("/onboarding")) await ensureOnboarded(page);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  const status = await page.request.get("/api/voice");
  expect(await status.json()).toMatchObject({
    enabled: false,
    provider: "deepgram",
    fallbackProvider: null,
  });
  await expect(page.getByRole("button", { name: "Start Orbit Voice" })).toBeDisabled();
  expect(
    (
      await page.request.post("/api/voice", {
        data: { action: "start", timeZone: "UTC" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await page.request.post("/api/voice", {
        headers: { Origin: "https://untrusted.invalid" },
        data: { action: "start", timeZone: "UTC" },
      })
    ).status(),
  ).toBe(403);
});

for (const provider of ["deepgram", "elevenlabs"] as const) {
  test(`${provider}: real SDK transcripts, tools, mute, interruption and live disable`, async ({
    page,
  }) => {
    await page.goto("/chat", { waitUntil: "domcontentloaded" });
  if (new URL(page.url()).pathname.startsWith("/onboarding")) await ensureOnboarded(page);
    let enabled = true;
    let ends = 0;
    let connected = 0;
    let tools = 0;
    let socket: WebSocketRoute | undefined;
    let sockets = 0;
    const frames: Record<string, unknown>[] = [];
    const turns: Array<{ id: string; text: string; interrupted: boolean }> = [];
    let rejectedTranscript = false;
    await page.addInitScript(() => {
      const originalClose = AudioContext.prototype.close;
      (window as unknown as { voiceCloses: number }).voiceCloses = 0;
      AudioContext.prototype.close = function () {
        (window as unknown as { voiceCloses: number }).voiceCloses++;
        return originalClose.call(this);
      };
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext();
        const destination = context.createMediaStreamDestination();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = .08;
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        const stream = destination.stream;
        for (const track of stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            stop();
            void context.close();
          };
        }
        return stream;
      };
    });
    await page.route("**/api/voice", async (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({
          json: {
            enabled,
            provider,
            fallbackProvider: null,
            revision: "test-generation",
          },
        });
      const body = route.request().postDataJSON();
      if (body.action === "transcript") {
        turns.push(body.turn);
        if (!rejectedTranscript && body.turn.source === "user") {
          rejectedTranscript = true;
          return route.fulfill({status: 503, json: {error: "Transcript temporarily unavailable"}});
        }
      }
      if (body.action === "start") {
        expect(body.threadId).toMatch(/^[a-f0-9-]{36}$/);
        return route.fulfill({
          json: {
            sessionId: id,
            threadId: body.threadId,
            expiresAt: new Date(Date.now() + 600000).toISOString(),
            credentials:
              provider === "deepgram"
                ? {
                    provider,
                    accessToken: "short-lived-test-token",
                    agent: {
                      listen: {
                        provider: { type: "deepgram", model: "nova-3" },
                      },
                      think: {
                        provider: { type: "open_ai", model: "gpt-4o-mini" },
                        prompt: "Use orbit_tool for CRM context",
                        functions: [
                          {
                            name: "orbit_tool",
                            description: "CRM bridge",
                            parameters: { type: "object" },
                          },
                        ],
                      },
                      speak: {
                        provider: {
                          type: "deepgram",
                          model: "aura-2-asteria-en",
                        },
                      },
                    },
                  }
                : {
                    provider,
                    signedUrl:
                      "wss://api.elevenlabs.io/v1/convai/conversation?test=1",
                    instructions: "Use orbit_tool for CRM context",
                    tts: {},
                  },
          },
        });
      }
      if (body.action === "connected") connected++;
      if (body.action === "end") ends++;
      if (body.action === "tool") {
        tools++;
        expect(body.sessionId).toBe(id);
        expect(body.tool).toBe("get_contact");
        expect(body.input).toEqual({ contactId });
        return route.fulfill({
          json: {
            result: JSON.stringify({
              untrusted_crm_data: {
                name: "Ada",
                aiSummary: "Compiler researcher",
              },
            }),
            proposal: null,
          },
        });
      }
      return route.fulfill({
        status: enabled ? 200 : 403,
        json: enabled ? { ok: true } : { error: "Voice disabled" },
      });
    });
    await page.routeWebSocket(
      provider === "deepgram"
        ? "wss://agent.deepgram.com/**"
        : "wss://api.elevenlabs.io/**",
      (ws) => {
        socket = ws;
        sockets++;
        ws.onMessage((raw) => {
          if (typeof raw !== "string") return;
          const message = JSON.parse(raw);
          if (!message.user_audio_chunk) frames.push(message);
          if (message.type === "Settings")
            ws.send(JSON.stringify({ type: "SettingsApplied" }));
          if (message.type === "conversation_initiation_client_data")
            ws.send(
              JSON.stringify({
                type: "conversation_initiation_metadata",
                conversation_initiation_metadata_event: {
                  conversation_id: "conv_test",
                  agent_output_audio_format: "pcm_16000",
                  user_input_audio_format: "pcm_16000",
                },
              }),
            );
        });
        if (provider === "deepgram")
          ws.send(
            JSON.stringify({ type: "Welcome", request_id: "voice-test" }),
          );
      },
    );
    await page.goto("/chat", { waitUntil: "domcontentloaded" });
    const composer = page.getByRole("combobox", { name: "Message Orbit" });
    await composer.fill("Hello Orbit");
    await expect(page.getByRole("button", {name: "Send", exact: true})).toBeVisible();
    await composer.fill("   ");
    await page.getByRole("button", { name: "Start Orbit Voice" }).click();
    await expect(page.getByRole("region", {name: "Orbit Voice", exact: true})).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Mute", exact: true }),
    ).toBeVisible();
    await expect.poll(() => connected).toBe(1);
    const inputLevel = () => page.locator(".voice-orbit").evaluate(el => Number((el as HTMLElement).style.getPropertyValue("--voice-input")));
    await expect.poll(inputLevel).toBeGreaterThan(.01);
    const send = (message: unknown) => socket!.send(JSON.stringify(message));
    if (provider === "deepgram") {
      send({
        type: "ConversationText",
        role: "user",
        content: "Prepare for Ada",
      });
      send({
        type: "ConversationText",
        role: "assistant",
        content: "Ada researches compilers.",
      });
      const audio = Buffer.alloc(96000);
      for (let index = 0; index < 48000; index++) audio.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 220 / 24000) * 6000), index * 2);
      socket!.send(audio);
      await expect(
        page.getByRole("status").filter({ hasText: "Orbit is speaking" }),
      ).toBeVisible();
      await expect.poll(() => page.locator(".voice-orbit").evaluate(el => Number((el as HTMLElement).style.getPropertyValue("--voice-output")))).toBeGreaterThan(.01);
      const closes = await page.evaluate(
        () => (window as unknown as { voiceCloses: number }).voiceCloses,
      );
      send({ type: "UserStartedSpeaking" });
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { voiceCloses: number }).voiceCloses,
          ),
        )
        .toBeGreaterThan(closes);
      send({
        type: "FunctionCallRequest",
        functions: [
          {
            id: "tool_test",
            name: "orbit_tool",
            client_side: true,
            arguments: JSON.stringify({
              tool: "get_contact",
              input: JSON.stringify({ contactId }),
            }),
          },
        ],
      });
      await expect
        .poll(() =>
          frames.some((frame) => frame.type === "FunctionCallResponse"),
        )
        .toBe(true);
      // App control mid-call: the theme flips, the agent hears it worked, and the call is NOT
      // restarted (a theme change re-renders the panel; a reconnect would greet again).
      for (const theme of ["dark", "light"] as const) {
        send({
          type: "FunctionCallRequest",
          functions: [{ id: `theme_${theme}`, name: "orbit_tool", client_side: true,
            arguments: JSON.stringify({ tool: "set_theme", input: JSON.stringify({ theme }) }) }],
        });
        await expect
          .poll(() => frames.find((f) => f.type === "FunctionCallResponse" && f.id === `theme_${theme}`)?.content)
          .toContain(theme);
        await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
      }
      expect(sockets).toBe(1);
      // InjectAgentMessage makes Deepgram SAY its text; context for the agent must stay silent.
      expect(frames.some((f) => f.type === "InjectAgentMessage")).toBe(false);
    } else {
      send({
        type: "user_transcript",
        user_transcription_event: {
          user_transcript: "Prepare for Ada",
          event_id: 1,
        },
      });
      send({
        type: "agent_response",
        agent_response_event: {
          agent_response: "Ada researches compilers.",
          event_id: 2,
        },
      });
      send({ type: "interruption", interruption_event: { event_id: 3 } });
      send({
        type: "agent_response_correction",
        agent_response_correction_event: {
          original_agent_response: "Ada researches compilers.",
          corrected_agent_response: "Ada researches compilers",
          event_id: 2,
        },
      });
      send({
        type: "client_tool_call",
        client_tool_call: {
          tool_name: "orbit_tool",
          tool_call_id: "tool_test",
          event_id: 4,
          parameters: {
            tool: "get_contact",
            input: JSON.stringify({ contactId }),
          },
        },
      });
      await expect
        .poll(() => frames.some((frame) => frame.type === "client_tool_result"))
        .toBe(true);
    }
    await expect.poll(() => tools).toBe(1);
    await page.getByRole("button", {name: "Transcript", exact: true}).click();
    await expect(
      page.getByRole("log", { name: "Live voice transcript" }),
    ).toContainText("Prepare for Ada");
    await expect.poll(() => turns.filter(turn => turn.text === "Prepare for Ada").length).toBe(1);
    await page.getByRole("button", {name: "Retry saving", exact: true}).click();
    await expect.poll(() => turns.filter(turn => turn.text === "Prepare for Ada").length).toBe(2);
    expect(new Set(turns.filter(turn => turn.text === "Prepare for Ada").map(turn => turn.id)).size).toBe(1);
    await expect(page.getByRole("button", {name: "Retry saving", exact: true})).toHaveCount(0);
    await expect.poll(() => turns.some(turn => turn.interrupted)).toBe(true);
    expect(new Set(turns.filter(turn => turn.text.startsWith("Ada researches")).map(turn => turn.id)).size).toBe(1);
    const desktopScreenshot = test.info().outputPath(`${provider}-desktop.png`);
    await page.screenshot({path: desktopScreenshot});
    await test.info().attach(`${provider} desktop voice`, {path: desktopScreenshot, contentType: "image/png"});
    await page.getByRole("button", { name: "Mute", exact: true }).click();
    await expect.poll(inputLevel).toBeLessThan(.01);
    await expect(page.getByRole("button", { name: "Unmute" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "Unmute" }).click();
    // Leaving Chat keeps the call: it docks as Cosmo's bar at the bottom right of the next
    // page (localhost always previews `feature.cosmo`), then comes back inline when Chat opens
    // again — one connection throughout.
    const voice = page.getByRole("region", {name: "Orbit Voice", exact: true});
    const cosmo = page.getByRole("region", {name: "Cosmo", exact: true});
    await page.locator('a[href="/contacts"]:visible').first().click();
    await expect(page).toHaveURL(/\/contacts/);
    await expect(cosmo.getByRole("button", { name: "Mute", exact: true })).toBeVisible();
    await expect.poll(async () => {
      const box = await cosmo.boundingBox();
      const view = page.viewportSize()!;
      return Boolean(box && view.height - (box.y + box.height) < 40 && view.width - (box.x + box.width) < 32);
    }).toBe(true);
    const docked = test.info().outputPath(`${provider}-docked.png`);
    await page.screenshot({ path: docked });
    await test.info().attach(`${provider} docked voice`, { path: docked, contentType: "image/png" });
    await cosmo.getByRole("link", { name: "Open chat" }).click();
    await expect(page).toHaveURL(/\/chat/);
    await expect(voice.getByRole("button", { name: "Transcript", exact: true })).toBeVisible();
    expect(connected).toBe(1);
    expect(ends).toBe(0);
    // Leaving Chat and coming back must not reopen the provider socket: a new socket is a new
    // conversation, so the agent would start over mid-sentence.
    expect(sockets).toBe(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => {
      const box = await page.getByRole("region", {name: "Orbit Voice", exact: true}).boundingBox();
      return box && box.x >= -1 && box.x + box.width <= 391;
    }).toBe(true);
    await expect(page.getByRole("button", {name: "Transcript", exact: true})).toBeInViewport({ratio: 1});
    await expect(
      page.getByRole("button", { name: "End conversation", exact: true }),
    ).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const mobileScreenshot = test.info().outputPath(`${provider}-mobile.png`);
    await page.screenshot({ path: mobileScreenshot });
    await test.info().attach(`${provider} mobile voice`, {
      path: mobileScreenshot,
      contentType: "image/png",
    });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.emulateMedia({reducedMotion: "reduce"});
    await expect(page.getByRole("region", {name: "Orbit Voice", exact: true})).toHaveCSS("color", "rgb(231, 236, 241)");
    await expect(page.locator(".voice-orbit")).toHaveAttribute("data-reduced", "");
    const darkScreenshot = test.info().outputPath(`${provider}-dark-mobile.png`);
    await page.screenshot({path: darkScreenshot});
    await test.info().attach(`${provider} dark mobile voice`, {path: darkScreenshot, contentType: "image/png"});
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.getByRole("button", { name: "End conversation" }).click();
    await expect(
      page.getByRole("button", { name: "Start Orbit Voice" }),
    ).toBeVisible();
    await expect.poll(() => ends).toBe(1);
    await expect(composer).toBeFocused();
    await page.getByRole("button", { name: "Start Orbit Voice" }).click();
    await expect(
      page.getByRole("button", { name: "Mute", exact: true }),
    ).toBeVisible();
    enabled = false;
    await expect(page.getByRole("region", {name: "Orbit Voice", exact: true}).getByRole("alert")).toContainText("Voice settings changed", {timeout: 25000});
    await expect.poll(() => ends).toBe(2);
  });
}

test("fallback is explicit; microphone permissions fail gracefully", async ({
  page,
}) => {
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  if (new URL(page.url()).pathname.startsWith("/onboarding")) await ensureOnboarded(page);
  let allowFallback = false;
  const starts: boolean[] = [];
  await page.route("**/api/voice", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: {
          enabled: true,
          provider: "deepgram",
          fallbackProvider: allowFallback ? "elevenlabs" : null,
          revision: "test",
        },
      });
    const body = route.request().postDataJSON();
    if (body.action === "start") {
      starts.push(body.fallback);
      return route.fulfill({
        status: 503,
        json: { error: "Selected provider is unavailable" },
      });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      return context.createMediaStreamDestination().stream;
    };
  });
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Start Orbit Voice" }).click();
  await expect(page.getByRole("region", { name: "Orbit Voice", exact: true }).getByRole("alert")).toContainText(
    "Selected provider is unavailable",
  );
  await expect(
    page.getByRole("button", { name: "Try ElevenLabs" }),
  ).toHaveCount(0);
  allowFallback = true;
  await expect(
    page.getByRole("button", { name: "Try ElevenLabs" }),
  ).toBeVisible({ timeout: 20000 });
  expect(starts).toEqual([false]);
  await page.getByRole("button", { name: "Try ElevenLabs" }).click();
  await expect.poll(() => starts.length).toBe(2);
  expect(starts).toEqual([false, true]);
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Denied", "NotAllowedError");
    };
  });
  await page.getByRole("button", { name: "Retry Deepgram" }).click();
  await expect(page.getByRole("region", { name: "Orbit Voice", exact: true }).getByRole("alert")).toContainText(
    "Microphone access was denied",
  );
  expect(starts.length).toBe(2);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", {name: "Orbit Voice", exact: true})).toHaveCount(0);
  await expect(page.getByRole("combobox", {name: "Message Orbit"})).toBeFocused();
});

test("admin persists provider and model choices without redeployment", async ({
  page,
}) => {
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  if (new URL(page.url()).pathname.startsWith("/onboarding")) await ensureOnboarded(page);
  await page.goto("/admin/product/chat", { waitUntil: "domcontentloaded" });
  const provider = page.getByLabel("Voice provider", { exact: true });
  await expect(provider).toHaveValue("deepgram");
  const adminScreenshot = test.info().outputPath("admin-voice.png");
  await page.screenshot({ path: adminScreenshot, fullPage: true });
  await test.info().attach("Admin voice configuration", {
    path: adminScreenshot,
    contentType: "image/png",
  });
  await untilHydrated(
    async () => {
      await provider.selectOption("elevenlabs");
    },
    () => expect(page.getByLabel("ElevenLabs speech model")).toBeVisible({ timeout: 2000 }),
  );
  await page
    .getByLabel("ElevenLabs speech model")
    .selectOption("eleven_turbo_v2");
  await page.getByRole("button", { name: "Save voice settings" }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/voice")).json()).provider,
    )
    .toBe("elevenlabs");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(provider).toHaveValue("elevenlabs");
  await expect(page.getByLabel("ElevenLabs speech model")).toHaveValue(
    "eleven_turbo_v2",
  );
  await untilHydrated(
    async () => {
      await provider.selectOption("deepgram");
    },
    () => expect(page.getByLabel("Listening model")).toBeVisible({ timeout: 2000 }),
  );
  await page.getByRole("button", { name: "Save voice settings" }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/voice")).json()).provider,
    )
    .toBe(DEFAULT_VOICE_CONFIG.provider);
});
