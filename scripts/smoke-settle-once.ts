/**
 * Guards `createSettler` (`src/lib/settle-once.ts`) — the promise wrapper that gives a
 * callback-driven browser API (the Google Picker, first) exactly-once settlement even when
 * the callback fires twice or never fires at all.
 *
 * Also drives the two Google loaders built on it (`src/lib/imports/google-picker.ts`) against a
 * fake `window`: the Google Identity Services token request (drive.file only, closed window is a
 * cancel, blocked popup and silence are errors, a late second callback changes nothing) and
 * `gapi.load` reporting a failure instead of never calling back.
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-settle-once.ts
 */
import { createSettler } from "../src/lib/settle-once";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}`, extra ?? "");
}

async function main() {
  console.log("createSettler");

  {
    const s = createSettler<number>();
    check("not settled before either is called", !s.settled());
    s.resolve(1);
    check("settled after resolve", s.settled());
    check("resolves to the given value", (await s.promise) === 1);
  }

  {
    // A second resolve after the first is a silent no-op — the promise keeps its first value.
    const s = createSettler<number>();
    s.resolve(1);
    s.resolve(2);
    check("a second resolve does not override the first", (await s.promise) === 1);
  }

  {
    // A reject after an earlier resolve must not turn a settled promise into a rejection —
    // exactly the shape of a Picker callback firing PICKED and then, moments later, an
    // unrelated action the caller treats as a failure.
    const s = createSettler<number>();
    s.resolve(1);
    s.reject(new Error("too late"));
    check("a reject after resolve is ignored", (await s.promise) === 1);
  }

  {
    const err = new Error("boom");
    const s = createSettler<number>();
    s.reject(err);
    check("settled after reject", s.settled());
    let caught: unknown;
    try {
      await s.promise;
    } catch (e) {
      caught = e;
    }
    check("rejects with the given error", caught === err);
  }

  {
    // A resolve after an earlier reject must not turn a settled rejection into a resolution —
    // the mirror case of a timeout firing first and a late callback arriving after.
    const s = createSettler<number>();
    const err = new Error("first");
    s.reject(err);
    s.resolve(99);
    let caught: unknown;
    try {
      await s.promise;
    } catch (e) {
      caught = e;
    }
    check("a resolve after reject is ignored", caught === err);
  }

  await googleLoaders();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll settle-once checks passed.");
  process.exit(0);
}

type TokenConfig = {
  client_id: string;
  scope: string;
  include_granted_scopes: boolean;
  login_hint?: string;
  callback: (r: { access_token?: string; scope?: string; error?: string }) => void;
  error_callback: (e: { type?: string }) => void;
};

async function googleLoaders() {
  console.log("\nrequestPickerToken (Google Identity Services)");
  const g = globalThis as unknown as { window: unknown; document: unknown };
  const timers: Array<() => void> = [];
  let onRequest: (cfg: TokenConfig) => void = () => {};
  let lastConfig: TokenConfig | null = null;
  let requestedPrompt: string | undefined;
  let gapiBehaviour: "error" | "timeout" | "ok" = "error";
  const fakeWindow = {
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout: () => {},
    google: {
      accounts: {
        oauth2: {
          initTokenClient: (cfg: TokenConfig) => {
            lastConfig = cfg;
            return {
              requestAccessToken: (o?: { prompt?: string }) => {
                requestedPrompt = o?.prompt;
                onRequest(cfg);
              },
            };
          },
        },
      },
    } as Record<string, unknown>,
    gapi: {
      load: (_lib: string, c: { callback: () => void; onerror: () => void; ontimeout: () => void }) => {
        if (gapiBehaviour === "error") c.onerror();
        else if (gapiBehaviour === "timeout") c.ontimeout();
        else c.callback();
      },
    },
  };
  g.window = fakeWindow;
  g.document = {
    createElement: () => ({ remove() {} }) as Record<string, unknown>,
    head: {
      appendChild: (el: { onload?: () => void }) => queueMicrotask(() => el.onload?.()),
    },
  };
  const { requestPickerToken, openDrivePicker, DRIVE_FILE_SCOPE } = await import("../src/lib/imports/google-picker");
  const { isUserFacingError } = await import("../src/lib/errors");

  const outcome = async (p: Promise<unknown>) => {
    try {
      return { value: await p };
    } catch (err) {
      return { err };
    }
  };

  onRequest = (cfg) => {
    cfg.callback({ access_token: "tok-1", scope: DRIVE_FILE_SCOPE });
    cfg.callback({ access_token: "tok-2", scope: DRIVE_FILE_SCOPE }); // a late second answer
  };
  const got = await outcome(requestPickerToken({ clientId: "cid", loginHint: "me@example.com" }));
  check("resolves the token Google hands back", got.value === "tok-1", got);
  const cfg = lastConfig as TokenConfig | null;
  check("asks for drive.file and nothing else", cfg?.scope === DRIVE_FILE_SCOPE && cfg.include_granted_scopes === false, cfg);
  check("uses the server's client id and the connected account as the hint", cfg?.client_id === "cid" && cfg.login_hint === "me@example.com");
  check("asks with prompt \"\" so Google only shows a screen when it must", requestedPrompt === "");

  onRequest = (c) => c.error_callback({ type: "popup_closed" });
  check("closing Google's window is a cancel (null)", (await outcome(requestPickerToken({ clientId: "cid" }))).value === null);

  onRequest = (c) => c.callback({ error: "access_denied" });
  check("declining on Google's screen is a cancel (null)", (await outcome(requestPickerToken({ clientId: "cid" }))).value === null);

  onRequest = (c) => c.error_callback({ type: "popup_failed_to_open" });
  const blocked = await outcome(requestPickerToken({ clientId: "cid" }));
  check("a blocked popup rejects with a sentence a person can act on", isUserFacingError(blocked.err) && /pop-ups/.test((blocked.err as Error).message), blocked);

  onRequest = (c) => c.callback({ error: "server_error" });
  const oauthErr = await outcome(requestPickerToken({ clientId: "cid" }));
  check("an OAuth error rejects with our own words, not Google's", isUserFacingError(oauthErr.err) && !/server_error/.test((oauthErr.err as Error).message));

  onRequest = () => {}; // Google never answers
  timers.length = 0;
  const silent = requestPickerToken({ clientId: "cid" });
  await new Promise((r) => setTimeout(r, 0));
  timers.forEach((fire) => fire());
  const silentOut = await outcome(silent);
  check("a token request that never answers rejects once its timer fires", isUserFacingError(silentOut.err), silentOut);

  console.log("\nloadPickerLibrary (gapi.load)");
  gapiBehaviour = "error";
  const loadErr = await outcome(openDrivePicker({ accessToken: "t", apiKey: "k", appId: "a" }));
  check("gapi.load's onerror rejects instead of hanging", isUserFacingError(loadErr.err), loadErr);
  gapiBehaviour = "timeout";
  const loadTimeout = await outcome(openDrivePicker({ accessToken: "t", apiKey: "k", appId: "a" }));
  check("…and so does its ontimeout, after a failed first try (the cache was cleared)", isUserFacingError(loadTimeout.err), loadTimeout);
}

main();
