import { z } from "zod";
import { NextResponse } from "next/server";
import { requireUserForSurface } from "@/lib/plan-guards";
import { sameOriginGuard } from "@/lib/api/same-origin";
import { routeError } from "@/lib/api/route-error";
import { consumeBucket } from "@/lib/rate-limit";
import { voicePublicState, VoiceUnavailableError } from "@/lib/voice/settings";
import { VoiceProviderError } from "@/lib/voice/providers";
import {
  saveVoiceTurn,
  startVoiceSession,
  callVoiceTool,
  endVoiceSession,
  heartbeatVoiceSession,
  connectVoiceSession,
} from "@/lib/voice/sessions";
import { describeScreen } from "@/lib/cosmo/screen";

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
    threadId: z.string().uuid().optional(),
    fallback: z.boolean().default(false),
    freshIfMissing: z.boolean().default(false),
    // Page, record and visible control ids only; described server-side (describeScreen).
    screen: z
      .object({
        page: z.string().max(40).nullable(),
        id: z.string().max(60).nullable().optional(),
        targets: z.array(z.string().max(60)).max(40).default([]),
      })
      .optional(),
    history: z
      .array(
        z.object({
          source: z.enum(["user", "ai"]),
          text: z.string().max(1500),
        }),
      )
      .max(12)
      .default([]),
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
  z.object({ action: z.literal("transcript"), sessionId: z.string().uuid(),
    turn: z.object({ id: z.string().uuid(), source: z.enum(["user", "ai"]), text: z.string().min(1).max(4000), interrupted: z.boolean().default(false), revision: z.number().int().min(1).max(1000000) }),
  }),
  z.object({ action: z.literal("heartbeat"), sessionId: z.string().uuid() }),
  z.object({ action: z.literal("connected"), sessionId: z.string().uuid() }),
  z.object({
    action: z.literal("end"),
    sessionId: z.string().uuid(),
    outcome: z.enum(["ended", "failed"]).default("ended"),
  }),
]);
export async function GET() {
  try {
    await requireUserForSurface("page.chat");
    return json(await voicePublicState());
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
        return json(
          await startVoiceSession(
            userId,
            body.timeZone,
            body.fallback,
            body.history,
            body.threadId,
            { freshIfMissing: body.freshIfMissing, screen: describeScreen(body.screen) },
          ),
        );
      case "tool":
        return json(
          await callVoiceTool(userId, body.sessionId, body.tool, body.input),
        );
      case "transcript":
        await saveVoiceTurn(userId, body.sessionId, body.turn);
        return json({ ok: true });
      case "heartbeat":
        await heartbeatVoiceSession(userId, body.sessionId);
        return json({ ok: true });
      case "connected":
        await connectVoiceSession(userId, body.sessionId);
        return json({ ok: true });
      case "end":
        await endVoiceSession(userId, body.sessionId, body.outcome);
        return json({ ok: true });
    }
  } catch (err) {
    if (err instanceof VoiceProviderError)
      return json({ error: err.message, provider: err.provider }, 503);
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
