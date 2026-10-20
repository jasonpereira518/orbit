/**
 * Inflation and size caps on untrusted inputs (audit M-02, L-15): a .docx whose document.xml inflates
 * past the cap, a OneDrive body with no Content-Length, and an oversized extension page blob.
 * Pure: no database, no network (fetch is stubbed). Run: npx tsx scripts/smoke-cloud-files-bomb.ts
 */
import JSZip from "jszip";
import { MAX_DOCX_XML_BYTES, docxToText, readFileText } from "../src/lib/cloud-files";
import { MAX_PAGE_BLOB_CHARS, untrustedPageBlock } from "../src/lib/conversation-starters";
import type { PageContext } from "../src/lib/extension/contract";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}
async function errorName(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as Error).name || (e as Error).constructor.name;
  }
}

async function main() {
  const MB = 1024 * 1024;

  console.log("docx inflation...");
  {
    const zip = new JSZip();
    zip.file("word/document.xml", "<w:document><w:p>Hello <w:tab/>there</w:p><w:p>second</w:p></w:document>");
    const text = await docxToText(await zip.generateAsync({ type: "uint8array" }));
    check("a normal .docx still reads", text === "Hello \tthere\nsecond", JSON.stringify(text));
  }
  {
    const zip = new JSZip();
    zip.file("word/document.xml", "<w:document><w:p>" + " ".repeat(MAX_DOCX_XML_BYTES + MB) + "</w:p></w:document>", {
      compression: "DEFLATE",
    });
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const heap0 = process.memoryUsage().heapUsed;
    const name = await errorName(() => docxToText(bytes));
    const grew = (process.memoryUsage().heapUsed - heap0) / MB;
    check(`a ${Math.round(bytes.byteLength / 1024)} KB bomb is refused as too large`, /TooLarge/.test(name ?? ""), String(name));
    check("refusal does not hold the inflated body", grew < MAX_DOCX_XML_BYTES / MB * 2, `heap grew ${grew.toFixed(1)} MB`);
  }

  {
    // Understate the size in every header: the streaming count must still stop it.
    const zip = new JSZip();
    zip.file("word/document.xml", "x".repeat(MAX_DOCX_XML_BYTES + MB), { compression: "DEFLATE" });
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let patched = 0;
    for (let i = 0; i + 4 <= bytes.length; i++) {
      const sig = view.getUint32(i, true);
      if (sig === 0x04034b50) {
        view.setUint32(i + 22, 10, true);
        patched++;
      } else if (sig === 0x02014b50) {
        view.setUint32(i + 24, 10, true);
        patched++;
      }
    }
    const name = await errorName(() => docxToText(bytes));
    check("an understated zip header is still caught while inflating", patched >= 2 && /TooLarge/.test(name ?? ""), `patched ${patched}, got ${name}`);
  }

  console.log("OneDrive body without Content-Length...");
  {
    const chunk = new Uint8Array(MB).fill(0x61);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 64) return controller.close();
        sent++;
        controller.enqueue(chunk);
      },
    });
    const fetchImpl = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    const name = await errorName(() => readFileText({ token: "test-token", fetchImpl }, "microsoft", { id: "f1", name: "notes.txt" }));
    check("a chunked 64 MB body is refused", /TooLarge/.test(name ?? ""), String(name));
    check("reading stopped near the 10 MB cap", sent <= 12, `pulled ${sent} MB`);
  }
  {
    const fetchImpl = (async () => new Response("Met Sam at the expo.", { status: 200 })) as unknown as typeof fetch;
    const text = await readFileText({ token: "test-token", fetchImpl }, "microsoft", { id: "f2", name: "notes.txt" });
    check("a small OneDrive file still reads", text === "Met Sam at the expo.", JSON.stringify(text));
  }

  console.log("Extension page blob...");
  {
    const page = { text: { blob: "word ".repeat(MAX_PAGE_BLOB_CHARS) } } as unknown as PageContext;
    const block = untrustedPageBlock(page);
    check("an oversized page blob is cut to the cap", block.length < MAX_PAGE_BLOB_CHARS + 500, `block is ${block.length} chars`);
    const astral = { text: { blob: "𠀀".repeat(MAX_PAGE_BLOB_CHARS + 10) } } as unknown as PageContext;
    const cut = untrustedPageBlock(astral);
    check("the cut never leaves a lone surrogate", !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut));
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
