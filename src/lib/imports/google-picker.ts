"use client";

import { DRIVE_MIME, type PickedDriveFile } from "@/lib/imports/drive-triage";

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
  return new Promise((resolve) => {
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
        if (data.action === picker.Action.PICKED) {
          resolve(
            (data.docs ?? []).map((d) => ({
              id: d.id,
              name: d.name,
              mimeType: d.mimeType,
              modifiedTime: new Date(d.lastEditedUtc ?? Date.now()).toISOString(),
            })),
          );
        } else if (data.action === picker.Action.CANCEL) {
          resolve([]);
        }
      })
      .build()
      .setVisible(true);
  });
}
