"use client";

import { DRIVE_MIME, type PickedDriveFile } from "@/lib/imports/drive-triage";
import { UserFacingError } from "@/lib/errors";
import { createSettler } from "@/lib/settle-once";

/**
 * Google's file picker, and the browser-only token it runs on.
 *
 * ## Why the Picker gets its own token
 *
 * The grant Orbit stores server-side is the union of everything the person connected — Gmail,
 * Calendar, Drive — because the OAuth flow asks for `include_granted_scopes`. Any access token
 * minted from it carries all of those scopes, so it must never reach the browser. Instead the
 * Picker runs on a token Google Identity Services mints in the browser for exactly one scope,
 * `drive.file`. That token is used only to open the Picker: it is never sent to Orbit's
 * server and never stored — it lives in this module's call stack and is dropped with it.
 *
 * `drive.file` access is granted per OAuth client, not per token: a file picked here becomes
 * readable to the same client's server-side grant, which is what the import then exports with.
 * So the GIS client id must be the server's `GOOGLE_CLIENT_ID`, and the Picker's App ID must be
 * the same Google Cloud project.
 */
type PickerDoc = { id: string; name: string; mimeType: string; lastEditedUtc?: number };
type GapiLoadConfig = {
  callback: () => void;
  onerror: () => void;
  timeout: number;
  ontimeout: () => void;
};
type TokenResponse = { access_token?: string; scope?: string; error?: string };
type TokenClient = { requestAccessToken: (overrides?: { prompt?: string }) => void };
type GoogleWindow = Window & {
  gapi?: { load: (lib: string, config: GapiLoadConfig) => void };
  google?: {
    picker?: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- Google ships no types
    accounts?: {
      oauth2?: {
        initTokenClient: (config: {
          client_id: string;
          scope: string;
          include_granted_scopes: boolean;
          login_hint?: string;
          callback: (resp: TokenResponse) => void;
          error_callback: (err: { type?: string }) => void;
        }) => TokenClient;
      };
    };
  };
};

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GAPI_SRC = "https://apis.google.com/js/api.js";
const GIS_SRC = "https://accounts.google.com/gsi/client";

/**
 * How long we wait, from `setVisible(true)`, for Google to report ANY of loaded/picked/cancel.
 *
 * A bad API key, an App ID from the wrong GCP project, or the Picker failing to render can all
 * mean the callback we wired never fires — Google shows its own error state inside the iframe,
 * not through our callback. Without this, `openDrivePicker` would hang forever and the button
 * would never re-enable. 20s is generous: `loaded` alone normally arrives in well under a
 * second once the script is on the page.
 */
const PICKER_LOAD_TIMEOUT_MS = 20_000;
/** A script tag or `gapi.load` that has said nothing for this long is treated as failed. */
const LIBRARY_LOAD_TIMEOUT_MS = 20_000;
/**
 * The token request can sit on Google's consent window while the person reads it, so this is
 * long — it exists only so a window that never reports back (neither callback fires) can't
 * leave the button spinning forever.
 */
const TOKEN_REQUEST_TIMEOUT_MS = 3 * 60_000;

const PICKER_LOAD_FAILED = "Couldn’t load Google’s file picker — try again in a moment";
const SIGN_IN_LOAD_FAILED = "Couldn’t reach Google’s sign-in — try again in a moment";

const scripts = new Map<string, Promise<void>>();

/** Add a script once. A failed or silent load is forgotten, so the next press tries afresh. */
function loadScript(src: string, failure: string): Promise<void> {
  const cached = scripts.get(src);
  if (cached) return cached;
  const settler = createSettler<void>();
  const script = document.createElement("script");
  const timer = window.setTimeout(() => settler.reject(new UserFacingError(failure)), LIBRARY_LOAD_TIMEOUT_MS);
  script.src = src;
  script.async = true;
  script.onload = () => {
    window.clearTimeout(timer);
    settler.resolve();
  };
  script.onerror = () => {
    window.clearTimeout(timer);
    settler.reject(new UserFacingError(failure));
  };
  const promise = settler.promise.catch((err) => {
    scripts.delete(src);
    script.remove();
    throw err;
  });
  scripts.set(src, promise);
  document.head.appendChild(script);
  return promise;
}

let pickerLoading: Promise<void> | null = null;

function loadPickerLibrary(): Promise<void> {
  const w = window as GoogleWindow;
  if (w.google?.picker) return Promise.resolve();
  pickerLoading ??= loadScript(GAPI_SRC, PICKER_LOAD_FAILED)
    .then(
      () =>
        new Promise<void>((resolve, reject) => {
          // The config form, not a bare callback: a bare callback is never called when the
          // library fails to load, which would hang the button.
          w.gapi!.load("picker", {
            callback: () => resolve(),
            onerror: () => reject(new UserFacingError(PICKER_LOAD_FAILED)),
            timeout: LIBRARY_LOAD_TIMEOUT_MS,
            ontimeout: () => reject(new UserFacingError(PICKER_LOAD_FAILED)),
          });
        }),
    )
    .catch((err) => {
      pickerLoading = null;
      throw err;
    });
  return pickerLoading;
}

function loadIdentityLibrary(): Promise<void> {
  if ((window as GoogleWindow).google?.accounts?.oauth2) return Promise.resolve();
  return loadScript(GIS_SRC, SIGN_IN_LOAD_FAILED);
}

/**
 * Start fetching both Google libraries ahead of the press (hover or focus on the button).
 *
 * Google's token window is a popup, and browsers only allow a popup close to a user gesture —
 * loading the libraries after the click can spend that allowance. Failures here are silent;
 * the press itself retries and reports them.
 */
export function warmDrivePicker(): void {
  void loadIdentityLibrary().catch(() => {});
  void loadPickerLibrary().catch(() => {});
}

/**
 * A `drive.file`-only access token for the Picker, from Google Identity Services.
 *
 * Resolves `null` when the person closes Google's window or declines — that's a cancel, not an
 * error. `loginHint` is the Google account Orbit is connected to, so a browser signed in to
 * several accounts offers the right one first: a file picked as a different account is not
 * readable by the connected grant.
 */
export async function requestPickerToken(opts: {
  clientId: string;
  loginHint?: string | null;
}): Promise<string | null> {
  await loadIdentityLibrary();
  const oauth2 = (window as GoogleWindow).google?.accounts?.oauth2;
  if (!oauth2) throw new UserFacingError(SIGN_IN_LOAD_FAILED);

  const settler = createSettler<string | null>();
  const timer = window.setTimeout(() => {
    settler.reject(new UserFacingError("Google didn’t answer — try again in a moment"));
  }, TOKEN_REQUEST_TIMEOUT_MS);
  const finish = (fn: () => void) => {
    window.clearTimeout(timer);
    fn();
  };

  try {
    const client = oauth2.initTokenClient({
      client_id: opts.clientId,
      scope: DRIVE_FILE_SCOPE,
      // Only drive.file on this token, whatever else the person granted Orbit elsewhere.
      include_granted_scopes: false,
      ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          // `access_denied` is the person saying no on Google's screen: a cancel.
          if (resp.error === "access_denied") return finish(() => settler.resolve(null));
          return finish(() =>
            settler.reject(new UserFacingError("Google didn’t let Orbit open your Drive — try again")),
          );
        }
        const granted = resp.scope?.split(" ") ?? [DRIVE_FILE_SCOPE];
        if (!granted.includes(DRIVE_FILE_SCOPE)) return finish(() => settler.resolve(null));
        finish(() => settler.resolve(resp.access_token!));
      },
      error_callback: (err) => {
        if (err?.type === "popup_closed") return finish(() => settler.resolve(null));
        if (err?.type === "popup_failed_to_open") {
          return finish(() =>
            settler.reject(
              new UserFacingError("Your browser blocked Google’s sign-in window — allow pop-ups for Orbit and try again"),
            ),
          );
        }
        finish(() => settler.reject(new UserFacingError(SIGN_IN_LOAD_FAILED)));
      },
    });
    // `prompt: ""` — Google only shows a screen when it needs to (first consent, account choice).
    client.requestAccessToken({ prompt: "" });
  } catch (err) {
    finish(() => settler.reject(err instanceof Error ? err : new UserFacingError(SIGN_IN_LOAD_FAILED)));
  }

  return settler.promise;
}

export async function openDrivePicker(opts: {
  accessToken: string;
  apiKey: string;
  appId: string;
}): Promise<PickedDriveFile[]> {
  await loadPickerLibrary();
  const { picker } = (window as GoogleWindow).google!;
  const settler = createSettler<PickedDriveFile[]>();

  // Cleared the moment ANY of loaded/picked/cancel arrives — see PICKER_LOAD_TIMEOUT_MS.
  const timeoutId = window.setTimeout(() => {
    settler.reject(
      new UserFacingError("Google’s file picker didn’t load — try again in a moment"),
    );
  }, PICKER_LOAD_TIMEOUT_MS);

  try {
    const view = new picker.DocsView(picker.ViewId.DOCS)
      .setMimeTypes(`${DRIVE_MIME.doc},${DRIVE_MIME.slides}`)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false);
    new picker.PickerBuilder()
      .addView(view)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(opts.accessToken)
      .setDeveloperKey(opts.apiKey)
      .setAppId(opts.appId)
      // Mirrors MAX_DRIVE_FILES_PER_IMPORT (src/lib/drive-import-processor.ts) — that module
      // imports server-only code, so this stays a literal rather than an import.
      .setMaxItems(25)
      .setCallback((data: { action: string; docs?: PickerDoc[] }) => {
        if (
          data.action === picker.Action.LOADED ||
          data.action === picker.Action.PICKED ||
          data.action === picker.Action.CANCEL
        ) {
          window.clearTimeout(timeoutId);
        }
        if (data.action === picker.Action.PICKED) {
          settler.resolve(
            (data.docs ?? []).map((d) => ({
              id: d.id,
              name: d.name,
              mimeType: d.mimeType,
              modifiedTime: new Date(d.lastEditedUtc ?? Date.now()).toISOString(),
            })),
          );
        } else if (data.action === picker.Action.CANCEL) {
          settler.resolve([]);
        }
      })
      .build()
      .setVisible(true);
  } catch (err) {
    window.clearTimeout(timeoutId);
    settler.reject(
      err instanceof Error
        ? err
        : new UserFacingError("Couldn’t open Google’s file picker"),
    );
  }

  return settler.promise;
}
