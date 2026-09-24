import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { NextResponse, type NextRequest } from "next/server";
import { SHARE_TOKEN_MAX } from "@/lib/interest-list";
import { getInviterPlanet } from "@/lib/interest-list-ticket";
import { PLANET_GLOW, planetLabel, type WelcomePlanet } from "@/lib/welcome-planets";

/**
 * The waitlist's 1200×630 link preview, one per share token: the sharer's planet beside the
 * waitlist's pitch.
 *
 * UNBRANDED, like the rest of the waitlist (see `lib/waitlist-host.ts`): no product name,
 * and nothing about what it does beyond the one line the page itself says. No place in
 * line either — it moves, and this image sits in a day-long CDN cache.
 *
 * Public (see `PUBLIC_ROUTES`): social crawlers carry no session. A missing token renders
 * the generic "get your planet" card with a 200; an unknown token 308s to that same
 * tokenless URL, so every bogus token collapses onto one CDN entry and one render. Neither
 * ever fails, because X and LinkedIn cache a failed preview and never come back for it.
 *
 * Fonts are vendored TTFs (Satori reads TTF/OTF/WOFF, not woff2, and `next/font` exposes
 * no file). Read at request time, not imported: `next.config.ts` lists the directory in
 * `outputFileTracingIncludes` so the deploy bundle carries it.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_CONTROL = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400";
const FONT_DIR = path.join(process.cwd(), "src/app/api/interest-list/ticket-image/fonts");
const PLANET_DIR = path.join(process.cwd(), "public/landing/planets");

const BG = "#05070f";
const TEXT = "#e8f3f1";
const MUTED = "#9aada8";
const FAINT = "#6d807c";
const ACCENT = "#f2c14e";
const SEAM = "rgba(232, 243, 241, 0.22)";

/** `ImageResponse` wants a plain ArrayBuffer; `readFile` hands back a Buffer view. */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function loadAssets(planet: WelcomePlanet) {
  const [regular, italic, png] = await Promise.all([
    readFile(path.join(FONT_DIR, "Fraunces-Regular.ttf")),
    readFile(path.join(FONT_DIR, "Fraunces-Italic.ttf")),
    readFile(path.join(PLANET_DIR, `${planet}.png`)),
  ]);
  return {
    fonts: [
      { name: "Fraunces", data: toArrayBuffer(regular), weight: 400 as const, style: "normal" as const },
      { name: "Fraunces", data: toArrayBuffer(italic), weight: 400 as const, style: "italic" as const },
    ],
    planetSrc: `data:image/png;base64,${png.toString("base64")}`,
  };
}

function Card({
  planet,
  planetSrc,
  invited,
}: {
  planet: WelcomePlanet;
  planetSrc: string;
  /** A real sharer's card, rather than the generic one. */
  invited: boolean;
}) {
  return (
    <div
      style={{
        width: 1200,
        height: 630,
        display: "flex",
        background: BG,
        color: TEXT,
        fontFamily: "Fraunces",
        padding: 56,
      }}
    >
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          border: "1px solid rgba(232,243,241,0.10)",
          borderRadius: 32,
          background: "linear-gradient(180deg, rgba(232,243,241,0.05), rgba(232,243,241,0.015))",
        }}
      >
        {/* Stub */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            width: 380,
            borderRight: `2px dashed ${SEAM}`,
            padding: 40,
          }}
        >
          <div
            style={{
              display: "flex",
              width: 220,
              height: 220,
              borderRadius: 999,
              boxShadow: `0 0 90px ${PLANET_GLOW[planet]}`,
            }}
          >
            <img src={planetSrc} width={220} height={220} alt="" />
          </div>
          <div style={{ display: "flex", fontSize: 26, color: MUTED, marginTop: 28 }}>
            {invited ? planetLabel(planet) : "Early access"}
          </div>
        </div>
        {/* Details */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            flex: 1,
            padding: "40px 56px",
          }}
        >
          <div style={{ display: "flex", fontSize: 20, letterSpacing: 4, color: ACCENT }}>
            EARLY ACCESS · WAITLIST
          </div>
          {/*
            Two real element children, never a fragment and never a `{" "}` text node: Satori
            drops standalone whitespace and lays a fragment out as one nowrap row, so the
            accent word would run off the card instead of wrapping. The first span carries
            its own trailing gap as a margin; the accent word and its period share a span so
            they can never be split across lines.
          */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "baseline",
              fontSize: 64,
              lineHeight: 1.1,
              marginTop: 20,
              letterSpacing: -1.5,
            }}
          >
            <span style={{ marginRight: 18 }}>The future of</span>
            <span style={{ display: "flex" }}>
              <span style={{ fontStyle: "italic", color: ACCENT }}>networking</span>
              <span>.</span>
            </span>
          </div>
          <div style={{ display: "flex", fontSize: 26, color: MUTED, marginTop: 28, lineHeight: 1.4 }}>
            {invited
              ? "A friend saved you a seat. Join the waitlist for early access."
              : "A central intelligence for everyone you know. Join the waitlist for early access."}
          </div>
          <div style={{ display: "flex", fontSize: 22, color: FAINT, marginTop: 40 }}>
            Opening in waves
          </div>
        </div>
      </div>
    </div>
  );
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("token")?.trim() ?? "";
  const token = raw.length > 0 && raw.length <= SHARE_TOKEN_MAX ? raw : "";

  // A lookup failure (a transient DB hiccup) must not become a 500 — it falls through to
  // the generic card, same as a bogus token.
  // The planet is all the card needs, so this is the one-row planet read, not the ticket
  // with its place-in-line counting.
  let sharer: WelcomePlanet | null = null;
  if (token) {
    try {
      sharer = await getInviterPlanet(token);
    } catch (err) {
      console.error("[interest-list] ticket lookup failed for the image route", err);
    }
  }

  if (token && !sharer) {
    // Every bogus token would otherwise be its own cache key and its own render. Send them
    // all to the one generic card, which the CDN keeps for a day.
    const canonical = new URL(request.nextUrl);
    canonical.search = "";
    return NextResponse.redirect(canonical, { status: 308, headers: { "Cache-Control": CACHE_CONTROL } });
  }

  const planet: WelcomePlanet = sharer ?? "earth";

  // A missing/corrupt font or planet PNG, or any other failure building the full card,
  // must not 500 either — X and LinkedIn cache a failed preview and never retry. The
  // fallback below uses no vendored assets at all: plain text, Satori's built-in font,
  // on the same background, at the same size, with the same cache header.
  //
  // Both cards are awaited to a buffer before they are answered: `ImageResponse` renders
  // lazily as its body streams, so a render-time throw would escape this `try` entirely
  // and reach the crawler as a 500 with the headers already sent.
  try {
    const { fonts, planetSrc } = await loadAssets(planet);
    const png = await new ImageResponse(
      <Card planet={planet} planetSrc={planetSrc} invited={Boolean(sharer)} />,
      {
        width: 1200,
        height: 630,
        fonts,
      }
    ).arrayBuffer();
    return new Response(png, {
      headers: { "Content-Type": "image/png", "Cache-Control": CACHE_CONTROL },
    });
  } catch (err) {
    console.error("[interest-list] ticket image assets failed; serving the bare card", err);
    const png = await new ImageResponse(
      <div
        style={{
          width: 1200,
          height: 630,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: BG,
          color: TEXT,
          fontSize: 56,
        }}
      >
        <div style={{ display: "flex", fontSize: 20, letterSpacing: 4, color: ACCENT }}>
          EARLY ACCESS · WAITLIST
        </div>
        <div style={{ display: "flex", marginTop: 24 }}>The future of networking.</div>
      </div>,
      { width: 1200, height: 630 }
    ).arrayBuffer();
    return new Response(png, {
      headers: { "Content-Type": "image/png", "Cache-Control": CACHE_CONTROL },
    });
  }
}
