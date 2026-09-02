/**
 * Exercises `readCsvFromArchive` (src/lib/csv-archive.ts) — the shared ZIP/CSV reader
 * behind both the Connections and Messages LinkedIn importers. Builds ZIPs in memory with
 * JSZip and reads them back through the same code path the browser file picker uses.
 *
 * No DB, no network.
 *
 * Run: npx tsx scripts/smoke-csv-archive.ts
 */
import JSZip from "jszip";
import {
  CONNECTIONS_ENTRY,
  MESSAGES_ENTRY,
  readCsvFromArchive,
} from "../src/lib/csv-archive";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function zipFile(entries: Record<string, string>, name = "export.zip") {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) {
    zip.file(path, content);
  }
  const blob = await zip.generateAsync({ type: "arraybuffer" });
  return new File([blob], name);
}

async function main() {
  console.log("csv-archive smoke test…");

  // --- ZIP with only Connections.csv: matched, text returned, no siblings ---
  console.log("\nconnections-only ZIP");
  const connectionsOnly = await zipFile({
    "Connections.csv": "First Name,Last Name\nAda,Lovelace\n",
  });
  const connResult = await readCsvFromArchive(connectionsOnly, {
    entryPattern: CONNECTIONS_ENTRY,
    fallbackName: "Connections.csv",
    missingMessage: "No Connections.csv found in that ZIP.",
  });
  check("text contains Ada Lovelace row", connResult.text.includes("Ada,Lovelace"));
  check("fileName is Connections.csv", connResult.fileName === "Connections.csv", connResult.fileName);
  check("no sibling CSVs", connResult.siblingCsvs.length === 0, JSON.stringify(connResult.siblingCsvs));

  // --- ZIP with only messages.csv, but asked for Connections: throws, names messages.csv ---
  console.log("\nmessages-only ZIP read with the connections pattern");
  const messagesOnly = await zipFile({
    "messages.csv": "CONVERSATION ID,FROM,TO\nc1,Jane,Me\n",
  });
  let threw: unknown = null;
  try {
    await readCsvFromArchive(messagesOnly, {
      entryPattern: CONNECTIONS_ENTRY,
      fallbackName: "Connections.csv",
      missingMessage: "No Connections.csv found in that ZIP.",
    });
  } catch (err) {
    threw = err;
  }
  check("throws when Connections.csv is absent", threw instanceof Error);
  const missingMessage = threw instanceof Error ? threw.message : "";
  check(
    "error names messages.csv as what the ZIP actually has",
    missingMessage.includes("messages.csv"),
    missingMessage,
  );
  check(
    "error keeps the caller's missingMessage prefix",
    missingMessage.startsWith("No Connections.csv found in that ZIP."),
    missingMessage,
  );
  check(
    "error mentions LinkedIn's multi-part archives",
    missingMessage.includes("Part 1"),
    missingMessage,
  );

  // --- ZIP with both: matched entry wins, sibling is reported ---
  console.log("\nZIP with both Connections.csv and messages.csv");
  const both = await zipFile({
    "Connections.csv": "First Name,Last Name\nAda,Lovelace\n",
    "messages.csv": "CONVERSATION ID,FROM,TO\nc1,Jane,Me\n",
  });
  const bothResult = await readCsvFromArchive(both, {
    entryPattern: CONNECTIONS_ENTRY,
    fallbackName: "Connections.csv",
    missingMessage: "No Connections.csv found in that ZIP.",
  });
  check("matched Connections.csv text", bothResult.text.includes("Ada,Lovelace"));
  check(
    "siblingCsvs includes messages.csv",
    bothResult.siblingCsvs.includes("messages.csv"),
    JSON.stringify(bothResult.siblingCsvs),
  );
  check(
    "MESSAGES_ENTRY matches the reported sibling",
    bothResult.siblingCsvs.some((n) => MESSAGES_ENTRY.test(n)),
  );

  // --- Multi-part archive: Connections.csv nested under a "Part 1" folder ---
  console.log("\nmulti-part archive (Connections.csv under Part 1/)");
  const multiPart = await zipFile({
    "Part 1/Connections.csv": "First Name,Last Name\nGrace,Hopper\n",
    "Part 2/messages.csv": "CONVERSATION ID,FROM,TO\nc1,Jane,Me\n",
  });
  const multiResult = await readCsvFromArchive(multiPart, {
    entryPattern: CONNECTIONS_ENTRY,
    fallbackName: "Connections.csv",
    missingMessage: "No Connections.csv found in that ZIP.",
  });
  check("finds Connections.csv nested under Part 1/", multiResult.text.includes("Grace,Hopper"));
  check(
    "fileName is stripped to the base name",
    multiResult.fileName === "Connections.csv",
    multiResult.fileName,
  );
  check(
    "sibling from Part 2/ reported by base name",
    multiResult.siblingCsvs.includes("messages.csv"),
    JSON.stringify(multiResult.siblingCsvs),
  );

  // --- A plain .csv upload (not a ZIP): pure passthrough, no siblings ---
  console.log("\nplain .csv upload");
  const plainCsv = new File(["First Name,Last Name\nAda,Lovelace\n"], "Connections.csv", {
    type: "text/csv",
  });
  const plainResult = await readCsvFromArchive(plainCsv, {
    entryPattern: CONNECTIONS_ENTRY,
    fallbackName: "Connections.csv",
    missingMessage: "No Connections.csv found in that ZIP.",
  });
  check("passthrough text matches file contents", plainResult.text.includes("Ada,Lovelace"));
  check("passthrough fileName is the original name", plainResult.fileName === "Connections.csv");
  check("passthrough has no siblings", plainResult.siblingCsvs.length === 0);

  console.log("\nAll csv-archive checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });
