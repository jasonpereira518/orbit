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
  await expect(page.getByRole("button", { name: "Talk to Orbit" })).toHaveCount(
    0,
  );
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
    const frames: Record<string, unknown>[] = [];
    await page.addInitScript(() => {
      const originalClose = AudioContext.prototype.close;
      (window as unknown as { voiceCloses: number }).voiceCloses = 0;
      AudioContext.prototype.close = function () {
        (window as unknown as { voiceCloses: number }).voiceCloses++;
        return originalClose.call(this);
      };
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext();
        const stream = context.createMediaStreamDestination().stream;
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
      if (body.action === "start")
        return route.fulfill({
          json: {
            sessionId: id,
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
    await page.getByRole("button", { name: "Talk to Orbit" }).click();
    await page.getByRole("button", { name: "Start conversation" }).click();
    await expect(
      page.getByRole("button", { name: "Mute", exact: true }),
    ).toBeVisible();
    await expect.poll(() => connected).toBe(1);
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
      socket!.send(Buffer.alloc(96000));
      await expect(
        page.getByRole("status").filter({ hasText: "Orbit is speaking" }),
      ).toBeVisible();
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
    await expect(
      page.getByRole("log", { name: "Live voice transcript" }),
    ).toContainText("Prepare for Ada");
    await page.getByRole("button", { name: "Mute", exact: true }).click();
    await expect(page.getByRole("button", { name: "Unmute" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "Unmute" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("combobox", { name: "Message Orbit" }),
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
    await page.getByRole("button", { name: "End call" }).click();
    await expect(
      page.getByRole("button", { name: "Start conversation" }),
    ).toBeVisible();
    await expect.poll(() => ends).toBe(1);
    await page.getByRole("button", { name: "Start conversation" }).click();
    await expect(
      page.getByRole("button", { name: "Mute", exact: true }),
    ).toBeVisible();
    enabled = false;
    await expect(
      page.getByRole("button", { name: "Close Orbit Voice" }),
    ).toHaveCount(0, { timeout: 25000 });
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
  await page.getByRole("button", { name: "Talk to Orbit" }).click();
  await page.getByRole("button", { name: "Start conversation" }).click();
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
    () => provider.selectOption("elevenlabs"),
    () => expect(page.getByLabel("ElevenLabs speech model")).toBeVisible({ timeout: 2000 }),
  );
  await page
    .getByLabel("ElevenLabs speech model")
    .selectOption("eleven_turbo_v2_5");
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
    "eleven_turbo_v2_5",
  );
  await untilHydrated(
    () => provider.selectOption("deepgram"),
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
