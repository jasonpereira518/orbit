import { test, expect, type WebSocketRoute } from "@playwright/test";
import { ensureOnboarded } from "./helpers";

// The provider transport and microphone are simulated; no ElevenLabs key or paid call.
test("voice defaults off and its server refuses session creation", async ({
  page,
}) => {
  await ensureOnboarded(page);
  await page.goto("/chat");
  await expect(
    page.getByRole("heading", { name: "Chat with your network" }),
  ).toBeVisible();
  const status = await page.request.get("/api/voice");
  expect(await status.json()).toEqual({ enabled: false });
  await expect(page.getByRole("button", { name: "Talk to Orbit" })).toHaveCount(
    0,
  );
  const response = await page.request.post("/api/voice", {
    data: { action: "start", timeZone: "UTC" },
  });
  expect(response.status()).toBe(403);
  const crossSite = await page.request.post("/api/voice", {
    headers: { Origin: "https://untrusted.invalid" },
    data: { action: "start", timeZone: "UTC" },
  });
  expect(crossSite.status()).toBe(403);
});

test("voice SDK connects, transcribes, calls scoped tools, mutes and closes", async ({
  page,
}) => {
  await ensureOnboarded(page);
  let enabled = true;
  let ends = 0;
  let calls = 0;
  const messages: Record<string, unknown>[] = [];
  let socket: WebSocketRoute | undefined;
  await page.addInitScript(() => {
    // A silent local stream exercises real AudioContext/worklet setup without microphone access.
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      return context.createMediaStreamDestination().stream;
    };
  });
  await page.route("**/api/voice", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { enabled } });
    const body = route.request().postDataJSON();
    if (body.action === "start")
      return route.fulfill({
        json: {
          sessionId: "11111111-1111-4111-8111-111111111111",
          signedUrl: "wss://api.elevenlabs.io/v1/convai/conversation?test=1",
          instructions: "Use orbit_tool to look up CRM context.",
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        },
      });
    if (body.action === "tool") {
      expect(body.sessionId).toBe("11111111-1111-4111-8111-111111111111");
      expect(body.tool).toBe("get_contact");
      expect(body.input).toEqual({
        contactId: "22222222-2222-4222-8222-222222222222",
      });
      calls++;
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
    if (body.action === "end") ends++;
    return route.fulfill({
      status: enabled ? 200 : 403,
      json: enabled ? { ok: true } : { error: "Voice disabled" },
    });
  });
  await page.routeWebSocket("wss://api.elevenlabs.io/**", (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (!message.user_audio_chunk) messages.push(message);
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
  });
  await page.goto("/chat");
  await page.getByRole("button", { name: "Talk to Orbit" }).click();
  await page.getByRole("button", { name: "Start conversation" }).click();
  await expect(
    page.getByRole("button", { name: "Mute", exact: true }),
  ).toBeVisible();
  await expect.poll(() => Boolean(socket)).toBe(true);
  const send = (event: unknown) => socket!.send(JSON.stringify(event));
  send({
    type: "user_transcript",
    user_transcription_event: {
      user_transcript: "Help me prepare for Ada",
      event_id: 1,
    },
  });
  send({
    type: "agent_response",
    agent_response_event: {
      agent_response: "Let me find Ada’s context.",
      event_id: 2,
    },
  });
  const transcript = page.getByRole("log", { name: "Live voice transcript" });
  await expect(transcript).toContainText("Help me prepare for Ada");
  await expect(transcript).toContainText("Let me find Ada’s context.");
  send({ type: "interruption", interruption_event: { event_id: 3 } });
  send({
    type: "agent_response_correction",
    agent_response_correction_event: {
      original_agent_response: "Let me find Ada’s context.",
      corrected_agent_response: "Let me find Ada.",
      event_id: 2,
    },
  });
  await expect(transcript).toContainText("Let me find Ada.");
  await expect(transcript).not.toContainText("Ada’s context");
  send({
    type: "client_tool_call",
    client_tool_call: {
      tool_name: "orbit_tool",
      tool_call_id: "tool_test",
      event_id: 4,
      parameters: {
        tool: "get_contact",
        input: JSON.stringify({
          contactId: "22222222-2222-4222-8222-222222222222",
        }),
      },
    },
  });
  await expect.poll(() => calls).toBe(1);
  await expect
    .poll(() => messages.some((m) => m.type === "client_tool_result"))
    .toBe(true);
  await page.getByRole("button", { name: "Mute", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Unmute", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Unmute", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  for (let i = 0; i < 12; i++)
    send({
      type: "agent_response",
      agent_response_event: {
        agent_response: `Relationship context ${i}: follow up with Ada about the workshop next week.`,
        event_id: 10 + i,
      },
    });
  await expect(
    page.getByRole("combobox", { name: "Message Orbit" }),
  ).toBeInViewport();

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "End call" }).click();
  await expect(
    page.getByRole("button", { name: "Start conversation" }),
  ).toBeVisible();
  await expect.poll(() => ends).toBe(1);
  // Disabling an active call must also release the SDK connection and microphone.
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
