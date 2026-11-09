/**
 * The cloud-notes picker's previews, with Drive and Graph stubbed: the listing reads each
 * doc's owner, a thumbnail is fetched with the token only from Drive's thumbnail host and
 * comes back as a data: URL (null on any failure), OneDrive text files never ask Graph for
 * one, and the peek text is squeezed and cut at a word.
 *
 * Pure. Run: npx tsx scripts/smoke-cloud-files-preview.ts
 */
import { fileThumbnail, listRecentFiles, PREVIEW_MAX_CHARS, previewText } from "../src/lib/cloud-files";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const DOC = "application/vnd.google-apps.document";
type Call = { url: string; auth: string | null };

function stub(routes: (url: string) => Response) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return routes(url);
  };
  return { ctx: { token: "tok", fetchImpl }, calls };
}

async function main() {
  // Owners.
  {
    const { ctx } = stub(() =>
      Response.json({
        files: [
          { id: "a1", name: "Mine", mimeType: DOC, owners: [{ displayName: "Jason", me: true }] },
          { id: "b2", name: "Theirs", mimeType: DOC, owners: [{ displayName: "Ana Ruiz", me: false }] },
          { id: "c3", name: "Nobody", mimeType: DOC },
        ],
      }),
    );
    const { files } = await listRecentFiles(ctx, "google");
    check("my own doc's owner reads You", files[0]?.owner === "You", String(files[0]?.owner));
    check("someone else's doc names them", files[1]?.owner === "Ana Ruiz");
    check("a doc without owners is null", files[2]?.owner === null);
  }
  {
    const { ctx } = stub(() =>
      Response.json({ value: [{ id: "m1", name: "Notes.docx", file: {}, lastModifiedDateTime: "2026-11-01T10:00:00Z", createdBy: { user: { displayName: "Raj" } } }] }),
    );
    const { files } = await listRecentFiles(ctx, "microsoft");
    check("OneDrive owner comes from createdBy", files[0]?.owner === "Raj");
  }

  // Google thumbnails.
  const png = new Uint8Array([137, 80, 78, 71]);
  {
    const { ctx, calls } = stub((url) =>
      url.includes("googleapis.com")
        ? Response.json({ thumbnailLink: "https://lh3.googleusercontent.com/abc=s220" })
        : new Response(png, { headers: { "content-type": "image/png" } }),
    );
    const out = await fileThumbnail(ctx, "google", { id: "a1", name: "Mine" });
    check("thumbnail comes back as a data: URL", out === `data:image/png;base64,${Buffer.from(png).toString("base64")}`, String(out));
    check("thumbnail asked for at s400", calls[1]?.url === "https://lh3.googleusercontent.com/abc=s400", calls[1]?.url);
    check("thumbnail fetch carries the token", calls[1]?.auth === "Bearer tok");
  }
  {
    const { ctx, calls } = stub((url) =>
      url.includes("googleapis.com") ? Response.json({ thumbnailLink: "https://evil.example.com/x=s220" }) : new Response(png),
    );
    const out = await fileThumbnail(ctx, "google", { id: "a1", name: "Mine" });
    check("a thumbnail link off googleusercontent is refused", out === null);
    check("…and the token never goes there", calls.length === 1, calls.map((c) => c.url).join(", "));
  }
  {
    const { ctx } = stub((url) =>
      url.includes("googleapis.com")
        ? Response.json({ thumbnailLink: "https://lh3.googleusercontent.com/abc=s220" })
        : new Response("no", { status: 403 }),
    );
    check("a 403 on the image is null", (await fileThumbnail(ctx, "google", { id: "a1", name: "Mine" })) === null);
  }
  {
    const { ctx } = stub((url) =>
      url.includes("googleapis.com")
        ? Response.json({ thumbnailLink: "https://lh3.googleusercontent.com/abc=s220" })
        : new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
    );
    check("a non-raster image type is null", (await fileThumbnail(ctx, "google", { id: "a1", name: "Mine" })) === null);
  }
  {
    const { ctx } = stub(() => Response.json({}));
    check("a doc with no thumbnail is null", (await fileThumbnail(ctx, "google", { id: "a1", name: "Mine" })) === null);
  }

  // OneDrive thumbnails.
  {
    const { ctx, calls } = stub(() => Response.json({ url: "https://x.files.1drv.com/thumb.jpg" }));
    check("a .txt never asks Graph", (await fileThumbnail(ctx, "microsoft", { id: "m1", name: "notes.txt" })) === null && calls.length === 0);
    const out = await fileThumbnail(ctx, "microsoft", { id: "m1", name: "Notes.docx" });
    check("a .docx returns Graph's URL as is", out === "https://x.files.1drv.com/thumb.jpg", String(out));
  }
  {
    const { ctx } = stub(() => Response.json({ url: "http://x.files.1drv.com/thumb.jpg" }));
    check("a plain-http thumbnail URL is refused", (await fileThumbnail(ctx, "microsoft", { id: "m1", name: "a.docx" })) === null);
  }

  // Peek text.
  {
    const short = previewText("Attendees:  Ana,\t Raj\r\n\r\n\r\n\r\nAna is   moving.  ");
    check("whitespace squeezed, blank runs kept to one", short.text === "Attendees: Ana, Raj\n\nAna is moving." && !short.truncated, JSON.stringify(short));
    const long = previewText("word ".repeat(1000));
    check("long text is cut at the cap", long.truncated && long.text.length <= PREVIEW_MAX_CHARS + 1, String(long.text.length));
    check("…at a word, with an ellipsis", long.text.endsWith("word…"), long.text.slice(-10));
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll cloud preview checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
