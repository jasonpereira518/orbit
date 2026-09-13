import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";
import { SHARE_TOKEN_MAX, formatTicketNumber } from "@/lib/interest-list";
import { getTicketByShareToken } from "@/lib/interest-list-ticket";
import { PLANET_GLOW, planetLabel, type WelcomePlanet } from "@/lib/welcome-planets";

/**
 * The boarding pass as a 1200×630 link preview, one per share token.
 *
 * Public (see `PUBLIC_ROUTES`): social crawlers carry no session. Any token answers 200 —
 * a bogus one gets the generic "get your planet" card — because X and LinkedIn cache a
 * failed preview and never come back for it. No moons on the image: they would go stale
 * under the day-long CDN cache, and the number and planet are the part people share.
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
  number,
}: {
  planet: WelcomePlanet;
  planetSrc: string;
  /** null renders the generic card. */
  number: number | null;
}) {
  const label = planetLabel(planet);
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
          {number !== null ? (
            <div style={{ display: "flex", fontSize: 72, marginTop: 28, letterSpacing: -2 }}>
              #{formatTicketNumber(number)}
            </div>
          ) : null}
          <div style={{ display: "flex", fontSize: 26, color: MUTED, marginTop: number !== null ? 4 : 28 }}>
            {number !== null ? label : "Your planet awaits"}
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
            ORBIT · INTEREST LIST
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", fontSize: 56, lineHeight: 1.1, marginTop: 20, letterSpacing: -1.5 }}>
            {number !== null ? (
              <span>
                Passenger {formatTicketNumber(number)}, bound for{" "}
                <span style={{ fontStyle: "italic", color: ACCENT }}>{label}</span>.
              </span>
            ) : (
              <span>
                Every person who joins is handed a{" "}
                <span style={{ fontStyle: "italic", color: ACCENT }}>planet</span>.
              </span>
            )}
          </div>
          <div style={{ display: "flex", fontSize: 26, color: MUTED, marginTop: 28, lineHeight: 1.4 }}>
            {number !== null
              ? "Occasional notes from the one person building Orbit. Get your own planet."
              : "Occasional notes from the one person building Orbit. Join and get yours."}
          </div>
          <div style={{ display: "flex", fontSize: 22, color: FAINT, marginTop: 40 }}>
            orbit — the personal networking CRM
          </div>
        </div>
      </div>
    </div>
  );
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("token")?.trim() ?? "";
  const token = raw.length > 0 && raw.length <= SHARE_TOKEN_MAX ? raw : "";
  const ticket = token ? await getTicketByShareToken(token) : null;

  const planet: WelcomePlanet = ticket?.planet ?? "earth";
  const { fonts, planetSrc } = await loadAssets(planet);

  return new ImageResponse(
    <Card planet={planet} planetSrc={planetSrc} number={ticket?.number ?? null} />,
    {
      width: 1200,
      height: 630,
      fonts,
      headers: { "Cache-Control": CACHE_CONTROL },
    }
  );
}
