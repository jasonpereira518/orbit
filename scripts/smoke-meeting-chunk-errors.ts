/**
 * Which transcription failures are worth retrying. A key problem is terminal (422): every
 * later chunk of an hour-long call would fail the same way.
 * Run: npx tsx scripts/smoke-meeting-chunk-errors.ts
 */
import { chunkFailureResponse } from "../src/lib/meeting-chunk-errors";
import { MISSING_AI_API_KEY_MESSAGE, aiProviderErrorMessage } from "../src/lib/errors";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const noKey = chunkFailureResponse(new Error(MISSING_AI_API_KEY_MESSAGE));
check("no key → 422 no-transcription-key", noKey.status === 422 && noKey.body.code === "no-transcription-key");

// Depends on Phase 0 narrowing isMissingAiApiKeyError to Orbit's own message. If this
// comes back as no-transcription-key, Phase 0 has not landed — stop and check.
const authCopy = aiProviderErrorMessage(new Error("401 Unauthorized: invalid api key"), "OpenAI");
const auth = chunkFailureResponse(new Error(authCopy));
check("rejected key → 422 transcription-auth", auth.status === 422 && auth.body.code === "transcription-auth", JSON.stringify(auth));
check("…with the provider copy", auth.body.error === authCopy, auth.body.error);

const quota = chunkFailureResponse(new Error("429 You exceeded your current quota, please check your plan and billing details."));
check("out of credit → 422 transcription-quota", quota.status === 422 && quota.body.code === "transcription-quota", JSON.stringify(quota));
check("…never the raw provider text", !quota.body.error.includes("billing details"), quota.body.error);

const model = chunkFailureResponse(new Error("404 model not found: whisper-9"));
check("missing model → 422", model.status === 422 && model.body.code === "transcription-model_unavailable");

const timeout = chunkFailureResponse(new Error("Request timed out"));
check("a timeout is retryable (502)", timeout.status === 502 && timeout.body.code === undefined);
const rate = chunkFailureResponse(new Error("429 rate limit exceeded"));
check("a rate limit is retryable (502)", rate.status === 502);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
