import { NextResponse } from "next/server";
import { chatMessages, type ChatRecommendation } from "@/db/schema";
import { discardCountAfter, NotLastTurnError, resolveVersionTarget, truncateAfter } from "@/lib/chat-versions";
import { getDb } from "@/db";
import { chatWithNetworkStream } from "@/lib/ai";
import { prepareChatContext } from "@/lib/chat-context";
import { maybeGather } from "@/lib/chat-gather";
import { persistAssistantTurn } from "@/lib/chat-persist";
import { createStepEmitter, deriveFollowUps, plural } from "@/lib/chat-steps";
import { generateChatTitle, settleWithin, TITLE_GRACE_MS } from "@/lib/chat-title";
import { formatSse, type ChatStreamEvent } from "@/lib/chat-stream-protocol";
import { citedIds, stripUnresolvedMarkers } from "@/lib/chat-evidence";
import { validateProposedActions } from "@/lib/chat-proposed-actions";
import { friendlyError } from "@/lib/errors";
import { traced } from "@/lib/perf-trace";
import { isPaywallError } from "@/lib/entitlements";
import { requireUserForSurface } from "@/lib/plan-guards";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { TOAST_COPY } from "@/lib/toast-copy";
import { reportedFailure } from "@/lib/report-error";
import { createStreamRedactor } from "@/lib/ai-security";

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
        versionOf?: unknown;
      }
    | null;
  const threadId = typeof body?.threadId === "string" ? body.threadId : null;
  const contactId = typeof body?.contactId === "string" ? body.contactId : null;
  // Ids the composer resolved from its `@Name` chips. Bounded and re-checked against the
  // user's own rows in `loadAttachedPeople`, so a forged id reaches nothing.
  const contextContactIds = Array.isArray(body?.contextContactIds)
    ? body.contextContactIds.filter((id): id is string => typeof id === "string").slice(0, 10)
    : [];

  // Editing or regenerating the last turn. `versionOf` names the answer being replaced; a
  // question means "edit the text", its absence means "regenerate" (same question again).
  const versionOfRaw = body?.versionOf as
    | { assistantMessageId?: unknown; question?: unknown; confirmDiscard?: unknown }
    | undefined;
  const versionAssistantId =
    typeof versionOfRaw?.assistantMessageId === "string" ? versionOfRaw.assistantMessageId : null;
  const confirmDiscard = versionOfRaw?.confirmDiscard === true;

  let question: string;
  let versionTarget: Awaited<ReturnType<typeof resolveVersionTarget>> | null = null;
  if (versionAssistantId) {
    if (!threadId) return NextResponse.json({ error: "No conversation to version" }, { status: 400 });
    const db = await getDb();
    try {
      // Editing an OLDER turn discards everything after it and then behaves exactly like
      // regenerating the (now) last turn — see `chat-versions.ts`. Requires confirmation
      // first: this is destructive, and the count is what the confirm dialog shows.
      const discard = await discardCountAfter(db, userId, threadId, versionAssistantId).catch(() => 0);
      if (discard > 0) {
        if (!confirmDiscard) {
          return NextResponse.json(
            { error: "confirm_discard", discardCount: discard },
            { status: 409 }
          );
        }
        await truncateAfter(db, userId, threadId, versionAssistantId);
      }
      versionTarget = await resolveVersionTarget(db, userId, threadId, versionAssistantId);
    } catch (err) {
      if (err instanceof NotLastTurnError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      return NextResponse.json({ error: friendlyError(err, "That answer couldn’t be found") }, { status: 404 });
    }
    question =
      (typeof versionOfRaw?.question === "string" ? versionOfRaw.question.trim() : "") ||
      versionTarget.priorUserRow.content;
  } else {
    question = typeof body?.question === "string" ? body.question.trim() : "";
  }
  if (!question) return NextResponse.json({ error: "Question is required" }, { status: 400 });

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
          // A version request keeps the version being replaced's own attachments when the
          // client did not send new ones (a plain regenerate never does).
          contextContactIds:
            contextContactIds.length || !versionTarget
              ? contextContactIds
              : versionTarget.priorUserRow.attachedContacts.map((p) => p.id),
          steps,
          excludeSlot: versionTarget?.slot ?? null,
        });
        let persistedUserMessageId: string | null = null;
        if (threadId) {
          const db = await getDb();
          const [userRow] = await db
            .insert(chatMessages)
            .values({
              threadId,
              userId,
              role: "user",
              content: ctx.q,
              // Resolved server-side rather than trusted from the client: these are the people
              // `loadAttachedPeople` actually found and put in front of the model, so the mark
              // on a reloaded thread describes what the answer was really given.
              attachedContacts: ctx.attachedPeople.map((p) => ({ id: p.id, name: p.name })),
              ...(versionTarget
                ? { slot: versionTarget.slot, version: versionTarget.nextVersion, isActive: false }
                : {}),
            })
            .returning();
          persistedUserMessageId = userRow?.id ?? null;
        }

        // Name a NEW conversation from its first message. Started here, once retrieval is done,
        // so it runs alongside the answer stream — the answer takes far longer than the fast
        // model does, and the title is normally waiting by the time it lands. Only for a
        // thread with no title yet: a later turn must never rename the conversation.
        const titlePromise =
          threadId && !ctx.thread?.title ? generateChatTitle(userId, ctx.q) : null;

        // One retrieval answers most questions; the ones whose shape says it cannot — what
        // was discussed and when, a path to someone, a follow-up that refers back — get a
        // bounded research loop first. See `chooseDepth` and `gatherEvidence`.
        const { evidence, notePassages } = await maybeGather(userId, ctx, {
          requestStartedAt,
          signal: request.signal,
          steps,
        });

        steps.start("answer", "Writing the answer");
        // Secrets and fence markers are scrubbed from the LIVE stream, not only from what is
        // stored afterwards — see `createStreamRedactor`. (A scrub is recorded once the
        // stored copy is guarded, by `guardChatAnswer`; nothing is recorded here twice.)
        const redactor = createStreamRedactor();
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
              (delta) => {
                const safe = redactor.push(delta);
                if (safe) send({ type: "answer", delta: safe });
              },
              ctx.focusProfile,
              ctx.attachedContext,
              {
                signal: request.signal,
                goals: ctx.goals,
                attentionLite: ctx.attentionLite,
                evidence,
                notePassages,
                writingPreferences: ctx.writingInstructions,
              }
            ),
          { userId }
        );
        const tail = redactor.flush();
        if (tail) send({ type: "answer", delta: tail });
        steps.done("answer", { label: "Wrote the answer" });

        // The prose has already streamed live, marker and all — this only decides what gets
        // PERSISTED and what the chips render from. `validIds` is every id the model was
        // actually shown (`result.evidence`'s keys), not just the ones it used, so a marker
        // for an id outside that set can only be an invented citation.
        const validIds = new Set(Object.keys(result.evidence));
        const { text: cleanAnswer, strippedCount } = stripUnresolvedMarkers(result.answer, validIds);
        const cited = citedIds(cleanAnswer);
        const citedEvidence = Object.fromEntries(cited.map((id) => [id, result.evidence[id]]));
        if (strippedCount > 0) {
          steps.done("verify", { label: `Removed ${plural(strippedCount, "unsupported citation")}` });
        }

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
        if (cited.length > 0) send({ type: "evidence", items: citedEvidence });

        // Never a chat tool call, never executed here — only stored, for a person to confirm
        // from the transcript. See `@/lib/chat-proposed-actions` and the rule at the top of
        // `src/lib/mcp/server.ts`, which this mirrors on the chat surface's own output.
        const proposedActions = validateProposedActions(result.proposedActions, ctx.allowedContacts, ctx.contactNames);
        if (proposedActions.length > 0) send({ type: "actions", items: proposedActions });

        // A beat for a title that is nearly there, never longer: if it is not ready the thread
        // is named the old way (the first message, cut short) rather than holding the answer.
        const title = await settleWithin(titlePromise, TITLE_GRACE_MS);
        // Persisted before `done` so the client learns the real message id and title. The
        // CLEANED text, not what streamed live — an invented citation was already visible
        // for that turn, but a reload should never show a dead `[e99]` nobody can resolve.
        const saved = await persistAssistantTurn(userId, threadId, ctx.thread?.title ?? null, ctx.q, {
          answer: cleanAnswer,
          recommendations,
          activity: steps.snapshot(),
          title,
          evidence: citedEvidence,
          proposedActions,
          version:
            versionTarget && persistedUserMessageId
              ? { slot: versionTarget.slot, version: versionTarget.nextVersion, userMessageId: persistedUserMessageId }
              : undefined,
        });
        send({
          type: "done",
          messageId: saved.messageId,
          userMessageId: persistedUserMessageId,
          threadId,
          title: saved.title,
          version: versionTarget ? { slot: versionTarget.slot, version: versionTarget.nextVersion } : null,
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
