import { NextResponse } from "next/server";
import { chatMessages, type ChatRecommendation } from "@/db/schema";
import { getDb } from "@/db";
import { chatWithNetworkStream } from "@/lib/ai";
import { prepareChatContext } from "@/lib/chat-context";
import { persistAssistantTurn } from "@/lib/chat-persist";
import { formatSse, type ChatStreamEvent } from "@/lib/chat-stream-protocol";
import { friendlyError } from "@/lib/errors";
import { traced } from "@/lib/perf-trace";
import { isPaywallError } from "@/lib/entitlements";
import { requireUserForSurface } from "@/lib/plan-guards";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { TOAST_COPY } from "@/lib/toast-copy";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Streaming chat. The server action (`askNetwork`) returned the whole answer at once, so
 * the user watched a spinner for the full model latency; this streams the prose as the
 * model produces it and sends the recommendations once the stream ends. Retrieval and
 * persistence are shared with the action (`prepareChatContext`, `persistAssistantTurn`).
 *
 * Errors before the stream starts are a JSON body with a real status; after it starts the
 * status line is gone, so they are an `error` event.
 */
export async function POST(request: Request) {
  let userId: string;
  try {
    userId = await requireUserForSurface("page.chat");
  } catch (err) {
    const status = isPaywallError(err) ? 403 : 401;
    return NextResponse.json({ error: friendlyError(err, "Sign in to chat") }, { status });
  }

  try {
    await consumeBucket("chat", userId, RATE_LIMITS.chat);
  } catch (err) {
    if (isRateLimitedError(err)) {
      return NextResponse.json(
        { error: err.message },
        { status: 429, headers: { "Retry-After": String(err.retryAfterSec) } }
      );
    }
    throw err;
  }

  const body = (await request.json().catch(() => null)) as
    | {
        question?: unknown;
        threadId?: unknown;
        contactId?: unknown;
        contextContactIds?: unknown;
      }
    | null;
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) return NextResponse.json({ error: "Question is required" }, { status: 400 });
  const threadId = typeof body?.threadId === "string" ? body.threadId : null;
  const contactId = typeof body?.contactId === "string" ? body.contactId : null;
  // Ids the composer resolved from its `@Name` chips. Bounded and re-checked against the
  // user's own rows in `loadAttachedPeople`, so a forged id reaches nothing.
  const contextContactIds = Array.isArray(body?.contextContactIds)
    ? body.contextContactIds.filter((id): id is string => typeof id === "string").slice(0, 10)
    : [];

  let ctx: Awaited<ReturnType<typeof prepareChatContext>>;
  try {
    ctx = await prepareChatContext(userId, question, {
      threadId,
      focusContactId: contactId,
      contextContactIds,
    });
    if (threadId) {
      const db = await getDb();
      await db.insert(chatMessages).values({
        threadId,
        userId,
        role: "user",
        content: ctx.q,
        // Resolved server-side rather than trusted from the client: these are the people
        // `loadAttachedPeople` actually found and put in front of the model, so the mark on
        // a reloaded thread describes what the answer was really given.
        attachedContacts: ctx.attachedPeople.map((p) => ({ id: p.id, name: p.name })),
      });
    }
  } catch (err) {
    return NextResponse.json(
      { error: friendlyError(err, TOAST_COPY.chatFailed) },
      { status: 400 }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatStreamEvent) => controller.enqueue(encoder.encode(formatSse(event)));
      try {
        const result = await traced(
          "chat.stream",
          () =>
            chatWithNetworkStream(
              userId,
              ctx.scopedQuestion,
              ctx.modelContacts,
              ctx.priorTurns,
              ctx.orgRosters,
              ctx.attention,
              ctx.modelRecruiters,
              (delta) => send({ type: "answer", delta }),
              ctx.focusProfile,
              ctx.attachedContext
            ),
          { userId }
        );
        const recommendations = ctx.filterRecommendations(
          result.recommendations as ChatRecommendation[]
        );
        send({ type: "recommendations", items: recommendations });
        // Persisted before `done` so the client learns the real message id and title.
        const saved = await persistAssistantTurn(userId, threadId, ctx.thread?.title ?? null, ctx.q, {
          answer: result.answer,
          recommendations,
        });
        send({
          type: "done",
          messageId: saved.messageId,
          threadId,
          title: saved.title,
          retrieved: ctx.retrieved.map((c) => ({
            id: c.id,
            fullName: c.fullName,
            company: c.company,
            title: c.title,
            relevance: c.relevance,
          })),
        });
      } catch (err) {
        send({ type: "error", message: friendlyError(err, TOAST_COPY.chatFailed) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
