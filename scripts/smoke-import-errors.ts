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
  describeImportFailure,
  icsFailureLine,
  importFailureLine,
  splitReference,
  type ImportFailureCode,
} from "../src/lib/import-errors";
import { IMPORT_COPY } from "../src/lib/imports/import-copy";
import { withReference } from "../src/lib/errors";

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
