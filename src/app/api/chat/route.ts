import { NextResponse } from "next/server";
import { chatMessages, type ChatRecommendation } from "@/db/schema";
import { getDb } from "@/db";
import { chatWithNetworkStream } from "@/lib/ai";
import { prepareChatContext } from "@/lib/chat-context";
import { maybeGather } from "@/lib/chat-gather";
import { persistAssistantTurn } from "@/lib/chat-persist";
import { createStepEmitter, deriveFollowUps, plural } from "@/lib/chat-steps";
import { formatSse, type ChatStreamEvent } from "@/lib/chat-stream-protocol";
import { friendlyError } from "@/lib/errors";
import { traced } from "@/lib/perf-trace";
import { isPaywallError } from "@/lib/entitlements";
import { requireUserForSurface } from "@/lib/plan-guards";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { TOAST_COPY } from "@/lib/toast-copy";
import { reportedFailure } from "@/lib/report-error";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Streaming chat. The server action (`askNetwork`) returned the whole answer at once, so
 * the user watched a spinner for the full model latency; this streams the prose as the
 * model produces it and sends the recommendations once the stream ends. Retrieval and
 * persistence are shared with the action (`prepareChatContext`, `persistAssistantTurn`).
 *
 * Retrieval runs inside the stream rather than before it, so each stage can narrate itself
 * as `step` events — see `@/lib/chat-steps`. That is also why the headers now flush almost
 * immediately instead of after several seconds of search.
 *
 * Errors are split by what has already been sent. Auth, rate limiting and body validation
 * happen before the stream opens and return a JSON body with a real status; anything from
 * retrieval onwards arrives as an `error` event, because the status line is long gone.
 */
export async function POST(request: Request) {
  // The research step budgets against this, not against its own start: retrieval has
  // already spent part of `maxDuration` by the time it runs.
  const requestStartedAt = Date.now();
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

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatStreamEvent) => controller.enqueue(encoder.encode(formatSse(event)));
      const steps = createStepEmitter((step) => send({ type: "step", step }));
      try {
        // Retrieval runs INSIDE the stream so it can narrate itself. It used to be awaited
        // before the response existed, which meant the several seconds of query
        // understanding, hybrid search and reranking had no channel to report on and the
        // user watched one undifferentiated spinner. The cost of moving it is that a
        // retrieval failure now arrives as an `error` event rather than a 400, since the
        // status line is already gone — auth, rate limiting and validation stay above,
        // where they can still set a real status code.
        const ctx = await prepareChatContext(userId, question, {
          threadId,
          focusContactId: contactId,
          contextContactIds,
          steps,
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

        // One retrieval answers most questions; the ones whose shape says it cannot — what
        // was discussed and when, a path to someone, a follow-up that refers back — get a
        // bounded research loop first. See `chooseDepth` and `gatherEvidence`.
        const { evidence } = await maybeGather(userId, ctx, {
          requestStartedAt,
          signal: request.signal,
          steps,
        });

        steps.start("answer", "Writing the answer");
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
              ctx.attachedContext,
              { signal: request.signal, goals: ctx.goals, attentionLite: ctx.attentionLite, evidence }
            ),
          { userId }
        );
        steps.done("answer", { label: "Wrote the answer" });

        const rawRecommendations = result.recommendations as ChatRecommendation[];
        const recommendations = ctx.filterRecommendations(rawRecommendations);
        // Only worth a step when it actually caught something — a filter that passed
        // everything through did no work the user needs to hear about.
        const dropped = (rawRecommendations?.length ?? 0) - recommendations.length;
        if (dropped > 0) {
          steps.done("verify", {
            label: `Dropped ${plural(dropped, "suggestion")} not in your network`,
          });
        }
        send({ type: "recommendations", items: recommendations });
        // Persisted before `done` so the client learns the real message id and title.
        const saved = await persistAssistantTurn(userId, threadId, ctx.thread?.title ?? null, ctx.q, {
          answer: result.answer,
          recommendations,
          activity: steps.snapshot(),
        });
        send({
          type: "done",
          messageId: saved.messageId,
          threadId,
          title: saved.title,
          notice: ctx.searchNotice,
          followUps: deriveFollowUps({
            question: ctx.q,
            topRosterCompany: ctx.orgRosters[0]?.name ?? null,
            firstOverdueName: ctx.attention?.overdue[0]?.name ?? null,
            topContactName: ctx.retrieved[0]?.fullName ?? null,
          }),
          retrieved: ctx.retrieved.map((c) => ({
            id: c.id,
            fullName: c.fullName,
            company: c.company,
            title: c.title,
            relevance: c.relevance,
          })),
        });
      } catch (err) {
        // The client is gone: there is nobody to tell, and enqueueing now would throw. Not
        // an error of ours either — the provider call was aborted on purpose.
        if (request.signal.aborted) return;
        // The status line is already sent, so this reaches the client as an event. Report it:
        // a mid-stream failure used to leave no trace outside the person's screen.
        send({ type: "error", message: reportedFailure(err, TOAST_COPY.chatFailed, { where: "route.chat.stream", userId }).error });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by the runtime when the client disconnected.
        }
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
