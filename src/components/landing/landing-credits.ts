/**
 * Where the landing page's imagery came from: the provenance record for everything under
 * `public/landing/{hero,photos,video}/` that Orbit did not make itself, and the source of
 * the credit line the page shows (the CC BY 4.0 items require a visible credit).
 *
 * This lives in `src/`, not next to the files: `scripts/smoke-public-routes.ts` fails on any
 * extension in `public/` the proxy matcher does not serve, so a credits file cannot sit there.
 * The originals are not committed; `scripts/optimize-landing-assets.ts` rebuilds the served
 * files from `assets-src/landing/` once they are downloaded again from `source`.
 *
 * NASA and ESA material is used under their media guidelines: no logos, and nothing here may
 * suggest either agency endorses Orbit.
 */
export type LandingCredit = {
  /** What it is, as the visitor would name it. */
  title: string;
  /** The credit wording the owner asks for. Shown verbatim. */
  credit: string;
  licence: "CC BY 4.0" | "NASA media guidelines";
  source: string;
  downloaded: string;
  /** What was done to the original. */
  changes: string;
  /** Served files, as prefixes under `public/landing/`. */
  files: string[];
};

export const LANDING_CREDITS: LandingCredit[] = [
  {
    title: "Planet and Sun surface maps",
    credit: "Solar System Scope",
    licence: "CC BY 4.0",
    source: "https://www.solarsystemscope.com/textures/",
    downloaded: "2026-11-09",
    changes: "Resized to 1K and 2K and re-encoded as WebP.",
    files: [
      "hero/sun-", "hero/mercury-", "hero/venus-", "hero/mars-", "hero/jupiter-",
      "hero/saturn-", "hero/uranus-", "hero/neptune-",
    ],
  },
  {
    title: "Star map",
    credit: "NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC",
    licence: "NASA media guidelines",
    source: "https://svs.gsfc.nasa.gov/4851",
    downloaded: "2026-11-09",
    changes:
      "Milky Way map tone-mapped from the linear EXR, black point lowered, resized, re-encoded as WebP. The brightest 7,000 stars of the catalogue map are read out as positions (hero-stars.ts) and drawn as points.",
    files: ["hero/milkyway-"],
  },
  {
    title: "Asteroid Bennu model",
    credit: "NASA Visualization Technology Applications and Development (VTAD)",
    licence: "NASA media guidelines",
    source: "https://science.nasa.gov/resource/bennu-3d-model/",
    downloaded: "2026-11-09",
    changes: "Texture split out of the model file and re-encoded as WebP. Shown as a comet, with a drawn tail.",
    files: ["hero/bennu-"],
  },
  {
    title: "Orion, Canis Major and Canis Minor",
    credit: "Akira Fujii",
    licence: "CC BY 4.0",
    source: "https://esahubble.org/images/heic0516d/",
    downloaded: "2026-11-09",
    changes: "Resized and re-encoded; constellation lines and labels drawn over it.",
    files: ["photos/orion-"],
  },
  {
    title: "Cosmic Cliffs in the Carina Nebula",
    credit: "NASA, ESA, CSA, and STScI",
    licence: "CC BY 4.0",
    source: "https://esawebb.org/images/weic2205a/",
    downloaded: "2026-11-09",
    changes: "Resized, cropped and re-encoded.",
    files: ["photos/carina-"],
  },
  {
    title: "North American east coast at night, from the International Space Station",
    credit: "Earth Science and Remote Sensing Unit, NASA Johnson Space Center",
    licence: "NASA media guidelines",
    source: "https://eol.jsc.nasa.gov/BeyondThePhotography/CrewEarthObservationsVideos/",
    downloaded: "2026-11-09",
    changes: "Nine seconds cut from the middle of the pass, resized, looped with a cross-fade.",
    files: ["video/earth-night-"],
  },
];
