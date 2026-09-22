/**
 * Real Chrome, the real built extension, and a real toolbar action — over the
 * DevTools protocol in pipe mode. Zero dependencies.
 *
 * Why pipe mode and these flags: loading an unpacked extension
 * (`Extensions.loadUnpacked`) and firing its toolbar action
 * (`Extensions.triggerAction`) are only exposed over `--remote-debugging-pipe`
 * with `--enable-unsafe-extension-debugging`. Branded Chrome stopped honouring
 * `--load-extension` in 137, so this is also the only way in.
 *
 * Why a headed window: `triggerAction` runs on a TAB target, and headless
 * Chrome has no tab strip, so it refuses ("Action can only be triggered on a
 * tab target"). The window is placed off-screen and uses a throwaway profile.
 *
 * `triggerAction` goes through the same path as a click on the icon — the
 * permission spike showed it reproduces Chrome's real-click behaviour exactly,
 * including the old bug (docs/permission-spike.md).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function launchWithExtension(extensionDir) {
  const profile = mkdtempSync(join(tmpdir(), "orbit-e2e-"));
  const proc = spawn(
    CHROME,
    [
      ...(process.env.E2E_HEADLESS ? ["--headless=new"] : ["--window-position=-3000,-3000"]),
      "--window-size=1280,900",
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] }
  );
  const toChrome = proc.stdio[3];
  const fromChrome = proc.stdio[4];

  let seq = 0;
  const pending = new Map();
  let buffer = "";
  fromChrome.on("data", (chunk) => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const waiter = message.id ? pending.get(message.id) : null;
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${message.error.message} ${message.error.data ?? ""}`));
      else waiter.resolve(message.result);
    }
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      toChrome.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });

  const { id: extensionId } = await send("Extensions.loadUnpacked", { path: extensionDir });
  await sleep(800);

  const tabs = new Map(); // name -> { targetId, session }

  async function openTab(name, url) {
    const { targetId } = await send("Target.createTarget", { url });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    tabs.set(name, { targetId, session: sessionId });
    await sleep(700);
  }

  async function activate(name) {
    await send("Target.activateTarget", { targetId: tabs.get(name).targetId });
    await sleep(400);
  }

  async function navigate(name, url) {
    await send("Page.navigate", { url }, tabs.get(name).session);
    await sleep(900);
  }

  /** Click the toolbar icon, as far as Chrome is concerned, on this tab. */
  async function clickAction(name) {
    const { targetInfos: pages } = await send("Target.getTargets");
    const page = pages.find((t) => t.targetId === tabs.get(name).targetId);
    // The action runs on the TAB target that parents this page target.
    const { targetInfos: tabTargets } = await send("Target.getTargets", {
      filter: [{ type: "tab" }],
    });
    const tab = tabTargets.find((t) => t.url === page?.url);
    if (!tab) throw new Error(`no tab target for ${page?.url}`);
    await send("Extensions.triggerAction", { id: extensionId, targetId: tab.targetId });
    await sleep(900);
  }

  /** The side panel's visible text, or null while no panel is open. */
  async function panelText() {
    const { targetInfos } = await send("Target.getTargets");
    const panel = targetInfos.find((t) =>
      t.url.startsWith(`chrome-extension://${extensionId}/src/panel/index.html`)
    );
    if (!panel) return null;
    const { sessionId } = await send("Target.attachToTarget", {
      targetId: panel.targetId,
      flatten: true,
    });
    const result = await send(
      "Runtime.evaluate",
      { expression: "document.body.innerText", returnByValue: true },
      sessionId
    );
    await send("Target.detachFromTarget", { sessionId }).catch(() => {});
    return result.result.value ?? "";
  }

  /** Poll the panel until `predicate(text)` holds, or give up. */
  async function waitForPanel(predicate, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await panelText();
      if (last !== null && predicate(last)) return { ok: true, text: last };
      await sleep(200);
    }
    return { ok: false, text: last };
  }

  /**
   * Do what a context-menu click does after the click: hand the panel an
   * intent through storage.session, from the extension's own worker. CDP can't
   * open Chrome's context menu, so this covers everything downstream of it.
   */
  async function sendIntent(detail) {
    const { targetInfos } = await send("Target.getTargets");
    const worker = targetInfos.find(
      (t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extensionId}/`)
    );
    if (!worker) throw new Error("extension worker not running");
    const { sessionId } = await send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
    const result = await send(
      "Runtime.evaluate",
      {
        expression: `(async () => {
          const w = await chrome.windows.getLastFocused();
          const [t] = await chrome.tabs.query({ active: true, windowId: w.id });
          await chrome.storage.session.set({ "orbit:intent": {
            id: crypto.randomUUID(), at: Date.now(), tabId: t.id, windowId: w.id,
            ...${JSON.stringify(detail)},
          } });
          return true;
        })()`,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId
    );
    await send("Target.detachFromTarget", { sessionId }).catch(() => {});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description);
    await sleep(600);
  }

  /** Evaluate in a page tab opened with openTab, awaiting a promise. */
  async function evaluateIn(name, expression) {
    const result = await send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      tabs.get(name).session
    );
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description);
    return result.result.value;
  }

  /** Evaluate in the extension's service worker. */
  async function evaluateInWorker(expression) {
    const { targetInfos } = await send("Target.getTargets");
    const worker = targetInfos.find(
      (t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extensionId}/`)
    );
    if (!worker) throw new Error("extension worker not running");
    const { sessionId } = await send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    await send("Target.detachFromTarget", { sessionId }).catch(() => {});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description);
    return result.result.value;
  }

  async function close() {
    proc.kill();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }

  return {
    send, extensionId, openTab, activate, navigate, clickAction, panelText, waitForPanel,
    sendIntent, evaluateIn, evaluateInWorker, close,
  };
}
