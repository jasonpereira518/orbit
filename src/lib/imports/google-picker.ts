"use client";

import { DRIVE_MIME, type PickedDriveFile } from "@/lib/imports/drive-triage";
import { UserFacingError } from "@/lib/errors";
import { createSettler } from "@/lib/settle-once";

/**
 * Google's file picker, loaded only when someone presses the Drive button.
 *
 * With `drive.file`, a file becomes readable to Orbit by being picked here — which is why the
 * App ID must be the same Google Cloud project as the OAuth client.
 */
type PickerDoc = { id: string; name: string; mimeType: string; lastEditedUtc?: number };
type GapiWindow = Window & {
  gapi?: { load: (lib: string, cb: () => void) => void };
  google?: { picker: any }; // eslint-disable-line @typescript-eslint/no-explicit-any -- Google ships no types
};

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

let loading: Promise<void> | null = null;

function loadPickerLibrary(): Promise<void> {
  const w = window as GapiWindow;
  if (w.google?.picker) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.onload = () => w.gapi!.load("picker", () => resolve());
    script.onerror = () => {
      loading = null;
      reject(new Error("Couldn’t load Google’s file picker"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export async function openDrivePicker(opts: {
  accessToken: string;
  apiKey: string;
  appId: string;
}): Promise<PickedDriveFile[]> {
  await loadPickerLibrary();
  const { picker } = (window as GapiWindow).google!;
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
