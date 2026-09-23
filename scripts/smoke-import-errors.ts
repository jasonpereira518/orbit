/**
 * Friendly import failures — classification, copy, and the guarantee that nothing raw escapes.
 *
 * The samples are real: Postgres constraint prose, an OAuth token-endpoint body, a Neon socket
 * error, the stall backstop's own give-up line. Each one currently reaches a person's history
 * list and notification bell verbatim, which is what this module exists to stop.
 *
 * Pure tier: no database.
 *
 * Run: npx tsx scripts/smoke-import-errors.ts
 */
import {
  IMPORT_FAILURE_COPY,
  classifyImportError,
  classifyImportFailure,
  importRowProblemLine,
  describeImportFailure,
  icsFailureLine,
  importFailureLine,
  splitReference,
  type ImportFailureCode,
} from "../src/lib/import-errors";
import { IMPORT_COPY } from "../src/lib/imports/import-copy";
import { withReference } from "../src/lib/errors";
import { DRIVE_ROW_COPY } from "../src/lib/imports/drive-row-copy";
import { AI_ACCESS_COPY, MANAGED_PROVIDER_FAILURE_MESSAGE } from "../src/lib/ai-access-copy";
import { AiAccessError } from "../src/lib/ai-access";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
}

/** Text a real failure actually puts in `imports.error_message`. */
const SAMPLES: { raw: string; code: ImportFailureCode }[] = [
  { raw: "Contact limit reached on your plan", code: "contact_limit" },
  {
    raw: "Import stalled 3 times and gave up. Please re-upload the file to try again.",
    code: "stalled",
  },
  {
    raw: '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
    code: "needs_reconnect",
  },
  { raw: "Request failed with status code 401", code: "needs_reconnect" },
  {
    raw: "Request had insufficient authentication scopes.",
    code: "provider_permission",
  },
  {
    raw: "Google Calendar API returned 403: Forbidden",
    code: "provider_permission",
  },
  { raw: "User-rate limit exceeded. (429)", code: "rate_limited" },
  { raw: "canceling statement due to statement timeout", code: "timeout" },
  {
    raw: 'duplicate key value violates unique constraint "contacts_user_email_uidx"',
    code: "row_conflict",
  },
  { raw: "value too long for type character varying(255)", code: "database" },
  { raw: "fetch failed", code: "provider_unavailable" },
  { raw: "connect ECONNRESET 10.0.0.1:5432", code: "provider_unavailable" },
  { raw: "Unable to auto-detect delimiting character", code: "bad_file" },
  { raw: "Something nobody has ever seen before", code: "unknown" },
  {
    raw: "Your AI provider didn’t accept your API key — check it in Settings, then try again",
    code: "ai_key",
  },
  {
    raw: "Your AI provider says your account is out of credit — top up with them, then try again",
    code: "ai_key",
  },
  {
    raw: "Your AI model isn’t available — pick another in Settings, then try again",
    code: "ai_key",
  },
  {
    raw: "Add an AI key in Settings so Orbit can read your Drive files",
    code: "ai_key",
  },
  // The AI gate's own refusals, as `failImport` stores them (I1).
  { raw: AI_ACCESS_COPY.key_required, code: "ai_key" },
  { raw: AI_ACCESS_COPY.managed_limit, code: "ai_key" },
  { raw: AI_ACCESS_COPY.managed_unavailable, code: "ai_key" },
  { raw: MANAGED_PROVIDER_FAILURE_MESSAGE, code: "ai_key" },
];

console.log("Classification");
for (const { raw, code } of SAMPLES) {
  const got = classifyImportError(raw);
  check(
    `${raw.slice(0, 46)}${raw.length > 46 ? "…" : ""} → ${code}`,
    got === code,
    got,
  );
}
check(
  "an empty message is unknown, not a crash",
  classifyImportError("") === "unknown",
);
check("null is unknown", classifyImportError(null) === "unknown");

console.log("Classification from the error instance");
for (const reason of Object.keys(AI_ACCESS_COPY) as (keyof typeof AI_ACCESS_COPY)[]) {
  check(
    `an AiAccessError (${reason}) is ai_key`,
    classifyImportFailure(new AiAccessError(reason)) === "ai_key",
    classifyImportFailure(new AiAccessError(reason)),
  );
}
check(
  "an AiAccessError is ai_key by name alone (a second module instance)",
  classifyImportFailure(Object.assign(new Error("anything"), { name: "AiAccessError" })) === "ai_key",
);

console.log("A detail-sheet row's reason");
for (const [key, copy] of Object.entries(DRIVE_ROW_COPY)) {
  check(
    `Drive row copy "${key}" passes through as written`,
    importRowProblemLine("skipped", copy) === copy,
    importRowProblemLine("skipped", copy),
  );
}
check(
  "driver text on a row is still classified, not shown raw",
  importRowProblemLine("failed", 'duplicate key value violates unique constraint "x"') ===
    importFailureLine('duplicate key value violates unique constraint "x"'),
);
check(
  "a skipped row with no reason keeps its fallback",
  importRowProblemLine("skipped", null) === "Nothing in this row to attach to anyone",
);
check(
  "a failed row with no reason keeps its fallback",
  importRowProblemLine("failed", "") === "Orbit couldn’t save this row",
);

console.log("References");
const withRef = withReference(
  "duplicate key value violates unique constraint",
  "abc123",
);
check(
  "a reference is split off, not shown mid-sentence",
  splitReference(withRef).ref === "abc123",
);
check(
  "...leaving the message behind",
  splitReference(withRef).message.startsWith("duplicate key"),
);
check(
  "a reference does not change the code",
  classifyImportError(withRef) === "row_conflict",
);
check("no reference is fine", splitReference("plain").ref === null);

console.log("Nothing raw escapes");
const allOutputs = [
  ...SAMPLES.map((s) => importFailureLine(s.raw)),
  ...SAMPLES.map((s) => icsFailureLine(s.raw)),
  ...Object.values(IMPORT_FAILURE_COPY).flatMap((c) => [c.cause, c.next]),
  ...Object.values(IMPORT_COPY),
  ...Object.values(DRIVE_ROW_COPY),
  importFailureLine(withRef),
];
const LEAKS: { label: string; test: RegExp }[] = [
  {
    label: "a Postgres constraint name",
    test: /unique constraint|violates|character varying|pg_/i,
  },
  {
    label: "an OAuth body",
    test: /invalid_grant|error_description|access_token/i,
  },
  { label: "raw JSON", test: /[{}]|"error"/ },
  { label: "a status code", test: /\b(401|403|404|429|500|502|503)\b/ },
  {
    label: "a stack frame or host",
    test: /ECONN|\bat \w+\.|\d+\.\d+\.\d+\.\d+/,
  },
  { label: "the word failed", test: /failed/i },
  { label: "“Could not”", test: /could not/i },
  { label: "a straight apostrophe", test: /'/ },
];
for (const leak of LEAKS) {
  const offender = allOutputs.find((o) => leak.test.test(o));
  check(`no output contains ${leak.label}`, !offender, offender ?? "");
}
check(
  "no output ends in a period",
  !allOutputs.some((o) => o.endsWith(".")),
  allOutputs.find((o) => o.endsWith(".")) ?? "",
);
check(
  "no output is empty",
  allOutputs.every((o) => o.trim().length > 0),
);
check(
  "no line uses the em-dash connector twice",
  !allOutputs.some((o) => o.split(" — ").length > 2),
  allOutputs.find((o) => o.split(" — ").length > 2) ?? "",
);
check(
  "a calendar failure is never described as an import",
  !/import/i.test(icsFailureLine("something unrecognisable")),
  icsFailureLine("something unrecognisable"),
);

console.log("Copy completeness");
const CODES: ImportFailureCode[] = [
  "contact_limit",
  "needs_reconnect",
  "provider_permission",
  "rate_limited",
  "provider_unavailable",
  "timeout",
  "bad_file",
  "row_conflict",
  "database",
  "stalled",
  "ai_key",
  "unknown",
];
check(
  "every code has a cause and a next step",
  CODES.every((c) => {
    const copy = describeImportFailure(c);
    return copy.cause.length > 0 && copy.next.length > 0;
  }),
);
check(
  "the copy table has no code the type does not",
  Object.keys(IMPORT_FAILURE_COPY).length === CODES.length,
);
check(
  "the contact limit offers an upgrade rather than reading as an error",
  Boolean(describeImportFailure("contact_limit").fix) &&
    !/couldn’t|didn’t/i.test(describeImportFailure("contact_limit").cause),
  describeImportFailure("contact_limit").cause,
);

console.log("Calendar subscriptions");
check(
  "a public Google address is named as the cause",
  /secret iCal address/.test(
    icsFailureLine(
      "403 on https://calendar.google.com/calendar/ical/x/public/basic.ics",
    ),
  ),
  icsFailureLine(
    "403 on https://calendar.google.com/calendar/ical/x/public/basic.ics",
  ),
);
check(
  "a dead link says to paste a fresh one",
  /fresh one/.test(icsFailureLine("Request returned 404 Not Found")),
  icsFailureLine("Request returned 404 Not Found"),
);
check(
  "an empty ics error still says something useful",
  icsFailureLine(null).length > 20,
);

if (failures) {
  console.error(
    `\n${failures} import error check${failures === 1 ? "" : "s"} failed`,
  );
  process.exit(1);
}
console.log("\nimport error smoke tests passed");
process.exit(0);
