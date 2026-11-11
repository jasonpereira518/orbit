import { z } from "zod";
import { NextResponse } from "next/server";
import { requireUserForSurface } from "@/lib/plan-guards";
import { sameOriginGuard } from "@/lib/api/same-origin";
import { routeError } from "@/lib/api/route-error";
import { consumeBucket } from "@/lib/rate-limit";
import { getVoiceSettings, VoiceUnavailableError } from "@/lib/voice/settings";
import { voiceAvailable } from "@/lib/voice/policy";
import {
  startVoiceSession,
  callVoiceTool,
  endVoiceSession,
  requireVoiceSession,
} from "@/lib/voice/sessions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const json = (data: unknown, status = 200) =>
  NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store, private" },
  });
const command = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    timeZone: z
      .string()
      .max(100)
      .default("UTC")
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, "Choose a valid time zone."),
  }),
  z.object({
    action: z.literal("tool"),
    sessionId: z.string().uuid(),
    tool: z.string().max(80),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({ action: z.literal("heartbeat"), sessionId: z.string().uuid() }),
  z.object({ action: z.literal("end"), sessionId: z.string().uuid() }),
]);
export async function GET() {
  try {
    await requireUserForSurface("page.chat");
    const state = await getVoiceSettings();
    return json({ enabled: voiceAvailable(state.enabled, state.configured) });
  } catch (err) {
    return routeError(err, {
      fallback: "Couldn’t check Orbit Voice.",
      where: "voice.status",
    });
  }
}
export async function POST(request: Request) {
  const refused = sameOriginGuard(request, { json: true });
  if (refused) return refused;
  try {
    const userId = await requireUserForSurface("page.chat");
    await consumeBucket("voice-requests", userId, {
      limit: 120,
      windowSec: 60,
    });
    // Bound bytes before JSON parsing; tool inputs may contain private CRM text.
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "A voice command is required." }, 400);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 24000) {
        await reader.cancel();
        return json({ error: "Voice command is too large." }, 413);
      }
      chunks.push(value);
    }
    const body = command.parse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    switch (body.action) {
      case "start":
        return json(await startVoiceSession(userId, body.timeZone));
      case "tool":
        return json(
          await callVoiceTool(userId, body.sessionId, body.tool, body.input),
        );
      case "heartbeat":
        await requireVoiceSession(userId, body.sessionId);
        return json({ ok: true });
      case "end":
        await endVoiceSession(userId, body.sessionId);
        return json({ ok: true });
    }
  } catch (err) {
    if (err instanceof VoiceUnavailableError)
      return json({ error: err.message }, 403);
    if (err instanceof SyntaxError)
      return json({ error: "Invalid voice command." }, 400);
    return routeError(err, {
      fallback: "Orbit Voice couldn’t complete that request. Try again.",
      where: "voice.command",
    });
  }
}
