import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";
import { cardArt, cardArtSvg, type CardArt } from "@/lib/cards/card-art";
import { loadPublicCard } from "@/lib/cards/card-store";

/**
 * A card's 1200×630 link preview: the front of the card — its art, the name in gold, the role
 * — for iMessage, LinkedIn and Slack to draw from a pasted `/c/<slug>` link. Built like the
 * waitlist's ticket image (`api/interest-list/ticket-image`): vendored Fraunces read at request
 * time (`next.config.ts` traces the directory in), a CDN cache, and never a failure a crawler
 * would cache.
 *
 * Public under `/c/` (see `PUBLIC_ROUTES`). Only what the card itself shows: `loadPublicCard`
 * has already nulled the hidden fields, and a paused, reset or unreleased card is the same
 * as one that never existed — a 308 to the one generic Orbit card, so every bogus slug
 * collapses onto a single CDN entry and a single render.
 *
 * The art SVG carries no user text (lib/cards/card-art.ts), so it goes in as a data URI.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** An hour, not the ticket's day: an edited or paused card should not linger in previews. */
const CACHE_CONTROL = "public, max-age=300, s-maxage=3600, stale-while-revalidate=3600";
const FONT_DIR = path.join(process.cwd(), "src/app/api/interest-list/ticket-image/fonts");
/** Never a real slug (those are 11 characters): the generic card's address. */
const GENERIC = "orbit";
const W = 1200;
const H = 630;
const S = Math.min(W, H);
const INSET = 0.04 * S;

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function Front({ art, name, role }: { art: CardArt; name: string; role: string | null }) {
  const svg = cardArtSvg(art, { width: W, height: H, part: "front" });
  return (
    <div style={{ width: W, height: H, display: "flex", position: "relative", background: "#070b1a" }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- Satori draws this, not a browser. */}
      <img src={`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`} width={W} height={H} alt="" style={{ position: "absolute", top: 0, left: 0 }} />
      {/* The silver sheen, resting where the live card's sits untilted. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: W,
          height: H,
          display: "flex",
          backgroundImage: "linear-gradient(105deg, rgba(232,238,245,0) 36%, rgba(232,238,245,0.16) 47%, rgba(232,238,245,0) 58%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: INSET + 0.08 * S,
          bottom: INSET + 0.08 * S,
          width: W * 0.68,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            display: "flex",
            fontFamily: "Fraunces",
            fontSize: 0.12 * S,
            lineHeight: 1.08,
            letterSpacing: -0.8,
            paddingBottom: 6,
            color: "transparent",
            backgroundImage: "linear-gradient(100deg, #f6e7b8 0%, #d4b469 45%, #fff3cf 72%, #d4b469 100%)",
            backgroundClip: "text",
          }}
        >
          {name}
        </div>
        {role ? <div style={{ display: "flex", marginTop: 10, fontSize: 0.058 * S, color: "#cfd8dc" }}>{role}</div> : null}
      </div>
      <div
        style={{
          position: "absolute",
          right: INSET + 0.06 * S,
          bottom: INSET + 0.07 * S,
          display: "flex",
          fontSize: 0.036 * S,
          letterSpacing: 9,
          color: "rgba(255,255,255,0.55)",
        }}
      >
        ORBIT
      </div>
    </div>
  );
}

async function png(node: React.ReactElement, fonts?: NonNullable<ConstructorParameters<typeof ImageResponse>[1]>["fonts"]) {
  // Awaited to a buffer before answering: `ImageResponse` renders as its body streams, so a
  // render-time throw would otherwise escape the `try` below as a 500 with headers sent.
  const body = await new ImageResponse(node, { width: W, height: H, fonts }).arrayBuffer();
  return new Response(body, { headers: { "Content-Type": "image/png", "Cache-Control": CACHE_CONTROL } });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  // A lookup failure (a transient DB hiccup) must not become a 500: it draws the generic card.
  let card: Awaited<ReturnType<typeof loadPublicCard>> | undefined;
  if (slug !== GENERIC) {
    try {
      card = await loadPublicCard(slug);
    } catch (err) {
      console.error("[card-image] card lookup failed; serving the generic card", err);
    }
  }
  if (card === null) {
    return new Response(null, {
      status: 308,
      headers: { Location: new URL(`/c/${GENERIC}/image`, request.nextUrl).toString(), "Cache-Control": CACHE_CONTROL },
    });
  }

  const front = card
    ? { art: card.art, name: card.fullName, role: [card.title, card.company].filter(Boolean).join(" @ ") || null }
    : { art: cardArt("orbit", "gold"), name: "Orbit", role: "Personal Networking Intelligence" };

  try {
    const regular = await readFile(path.join(FONT_DIR, "Fraunces-Regular.ttf"));
    return await png(<Front {...front} />, [{ name: "Fraunces", data: toArrayBuffer(regular), weight: 400, style: "normal" }]);
  } catch (err) {
    // A missing font or a render failure: the bare card, built-in font, same size and cache —
    // X and LinkedIn cache a failed preview and never come back for it.
    console.error("[card-image] render failed; serving the bare card", err);
    return png(
      <div
        style={{ width: W, height: H, display: "flex", alignItems: "center", justifyContent: "center", background: "#070b1a", color: "#d4b469", fontSize: 72 }}
      >
        Orbit
      </div>
    );
  }
}
