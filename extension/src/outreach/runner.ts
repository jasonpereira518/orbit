import type {
  BrowserTask,
  BrowserCheckpoint,
  BrowserObservation,
} from "../../../src/lib/outreach-v2/types";
import { inspectOutreachPage, type PageState } from "./page";
import type { OrbitApi } from "../lib/api";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
function canonical(value: string) {
  if (value.startsWith("/in/")) value = `https://www.linkedin.com${value}`;
  try {
    const u = new URL(value);
    return `${u.origin}${u.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}
export class BrowserRunner {
  stopped = false;
  tabId: number | null = null;
  constructor(
    private api: OrbitApi,
    private sessionId: string,
    private progress: (text: string) => void,
  ) {}
  stop() {
    this.stopped = true;
  }
  private async command(method: string, params?: Record<string, unknown>) {
    if (this.stopped) throw new Error("Session paused.");
    return chrome.debugger.sendCommand({ tabId: this.tabId! }, method, params);
  }
  private async inspect() {
    const result = (await this.command("Runtime.evaluate", {
      expression: `(${inspectOutreachPage.toString()})()`,
      returnByValue: true,
    })) as { result: { value: PageState } };
    const state = result.result.value;
    const url = new URL(state.url);
    if (
      url.protocol !== "https:" ||
      ![
        "www.linkedin.com",
        "mail.google.com",
        "outlook.live.com",
        "outlook.office.com",
        "outlook.office365.com",
      ].includes(url.hostname)
    )
      throw new Error(
        "The browser left the supported site. Complete sign-in manually, then resume.",
      );
    return state;
  }
  private async click(point: { x?: number; y?: number } | null) {
    if (point?.x == null || point?.y == null)
      throw new Error(
        "Control unavailable. Open the provider and check its current state.",
      );
    await this.command("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await this.command("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await delay(600);
  }
  private async fill(point: { x: number; y: number } | null, text: string) {
    await this.click(point);
    const modifiers = navigator.platform.includes("Mac") ? 4 : 2;
    await this.command("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      modifiers,
    });
    await this.command("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      modifiers,
    });
    await this.command("Input.insertText", { text });
  }
  private async navigate(url: string) {
    const host = new URL(url).hostname;
    if (
      ![
        "www.linkedin.com",
        "mail.google.com",
        "outlook.live.com",
        "outlook.office.com",
        "outlook.office365.com",
      ].includes(host)
    )
      throw new Error("Unsupported destination.");
    await chrome.tabs.update(this.tabId!, { url, active: true });
    await delay(2500);
  }
  private async attach(url: string) {
    if (this.tabId) {
      await this.navigate(url);
      return;
    }
    const tab = await chrome.tabs.create({ url, active: true });
    this.tabId = tab.id!;
    await delay(2000);
    await chrome.debugger.attach({ tabId: this.tabId }, "1.3");
  }
  private async account(state: PageState, expected: string) {
    let openedMenu = false;
    if (!state.account && state.accountButton) {
      await this.click(state.accountButton);
      state = await this.inspect();
      openedMenu = true;
    }
    if (!state.account || canonical(state.account) !== canonical(expected))
      throw new Error(
        "The signed-in account could not be verified. Check the account menu and resume.",
      );
    if (state.blocked || state.login)
      throw new Error(
        "The site requires your attention. Complete its sign-in or account check manually.",
      );
    if (openedMenu) {
      await this.command("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
      });
      await this.command("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
      });
      const refreshed = await this.inspect();
      state = { ...refreshed, account: state.account };
    }
    return state;
  }
  private async checkpoint(
    task: BrowserTask,
    phase: BrowserCheckpoint["phase"],
    evidence?: string,
    url?: string,
  ) {
    await this.api.outreach({
      op: "checkpoint",
      sessionId: this.sessionId,
      jobId: task.jobId,
      token: task.leaseToken,
      checkpoint: {
        phase,
        sender: task.sender.address,
        recipient: task.recipient,
        subject: task.subject,
        body: task.body,
        evidence,
        conversationUrl: url,
      },
    });
  }
  private async locate(
    target:
      "Add a note button" | "Connection request button" | "Message button",
  ) {
    const shot = (await this.command("Page.captureScreenshot", {
      format: "png",
    })) as { data: string };
    if (shot.data.length > 190000)
      throw new Error("Page layout needs manual attention.");
    const point = await this.api.outreach<{
      x: number;
      y: number;
      confidence: string;
    }>({ op: "locate", sessionId: this.sessionId, image: shot.data, target });
    if (point.confidence !== "high")
      throw new Error(
        "The page control is uncertain; resume after checking it.",
      );
    return point;
  }
  private async send(task: BrowserTask) {
    let clicked = false;
    try {
      const transport = task.sender.transport;
      const params = new URLSearchParams({
        to: task.recipient,
        subject: task.subject,
        body: task.body,
      });
      const outlookHost = /@(outlook|hotmail|live)\./i.test(task.sender.address)
        ? "outlook.live.com/mail/0"
        : "outlook.office.com/mail";
      const url =
        transport === "linkedin"
          ? task.kind === "initial"
            ? task.profileUrl
            : task.conversationUrl
          : task.kind !== "initial"
            ? task.conversationUrl
            : transport === "gmail_web"
              ? `https://mail.google.com/mail/u/0/?view=cm&fs=1&${new URLSearchParams({ to: task.recipient, su: task.subject, body: task.body })}`
              : `https://${outlookHost}/deeplink/compose?${params}`;
      if (!url)
        throw new Error("Open the existing conversation before replying.");
      this.progress(`Preparing a message for ${task.recipientName}`);
      await this.attach(url);
      let state = await this.account(await this.inspect(), task.sender.address);
      if (
        transport === "linkedin" &&
        task.kind !== "initial" &&
        !state.bodyPosition
      ) {
        await this.click(
          state.message ?? (await this.locate("Message button")),
        );
        state = await this.inspect();
      }
      if (transport !== "linkedin" && task.kind !== "initial") {
        if (
          !state.messages.some(
            (m) =>
              m.from.toLowerCase() === task.recipient.toLowerCase() ||
              m.from.toLowerCase() === task.sender.address.toLowerCase(),
          )
        )
          throw new Error(
            "The existing email conversation could not be verified.",
          );
        await this.click(state.reply);
        state = await this.inspect();
      }
      if (transport === "linkedin" && task.kind === "initial") {
        if (canonical(state.url) !== canonical(task.profileUrl!))
          throw new Error("The recipient profile does not match.");
        if (state.pending || state.connected)
          throw new Error(
            "This person already has a pending invitation or is connected.",
          );
        await this.click(
          state.connect ?? (await this.locate("Connection request button")),
        );
        state = await this.inspect();
        if (!state.bodyPosition) {
          await this.click(
            state.addNote ?? (await this.locate("Add a note button")),
          );
          state = await this.inspect();
        }
        if (
          !state.dialogText
            .toLowerCase()
            .includes(task.recipientName.toLowerCase())
        )
          throw new Error("Invitation recipient could not be verified.");
      }
      await this.fill(state.bodyPosition, task.body);
      if (transport !== "linkedin" && state.subjectPosition)
        await this.fill(state.subjectPosition, task.subject);
      state = await this.account(await this.inspect(), task.sender.address);
      if (state.body.replace(/\r\n/g, "\n") !== task.body)
        throw new Error("The browser body differs from the approved message.");
      if (transport !== "linkedin") {
        if (
          state.subject !== task.subject ||
          state.recipients.length !== 1 ||
          state.recipients[0] !== task.recipient.toLowerCase()
        )
          throw new Error(
            "The email subject or recipient differs from the approved draft.",
          );
      } else if (
        task.kind !== "initial" &&
        canonical(state.conversationProfile ?? "") !==
          canonical(task.profileUrl ?? "")
      )
        throw new Error("Conversation recipient is uncertain.");
      if (!state.send) throw new Error("Send control unavailable.");
      await this.checkpoint(task, "prepared");
      // Persist the ambiguous boundary BEFORE performing the external effect.
      await this.checkpoint(task, "clicked");
      clicked = true;
      await this.click(state.send);
      await delay(1500);
      state = await this.inspect();
      const confirmed =
        transport === "linkedin"
          ? task.kind === "initial"
            ? state.pending
            : state.messages.some(
                (m) =>
                  m.body === task.body &&
                  canonical(m.from) === canonical(task.sender.address),
              )
          : state.confirmed;
      if (!confirmed)
        throw new Error(
          "Send was attempted, but its result could not be confirmed. Verify it in the provider.",
        );
      await this.checkpoint(
        task,
        "confirmed",
        transport === "linkedin"
          ? "Pending invitation or exact outbound message visible"
          : "Provider displayed message sent",
        transport === "linkedin" || task.kind !== "initial"
          ? state.url
          : await this.findSentConversation(task, state),
      );
      this.progress(`Sent to ${task.recipientName}`);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "Browser interrupted";
      await this.checkpoint(
        task,
        clicked ? "needs_verification" : "failed",
        reason,
      ).catch(() => {});
      throw error;
    }
  }
  private async findSentConversation(
    task: BrowserTask,
    state: PageState,
  ): Promise<string | undefined> {
    // Finding a thread never repeats a send. A missing thread keeps tracking stale.
    try {
      if (state.viewMessage) await this.click(state.viewMessage);
      else {
        if (state.site === "gmail")
          await this.navigate(
            `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(`in:sent to:${task.recipient} subject:${task.subject}`)}`,
          );
        else {
          await this.navigate(new URL(state.url).origin + "/mail/");
          state = await this.inspect();
          await this.fill(
            state.searchPosition,
            `to:${task.recipient} subject:"${task.subject.replaceAll('"', "")}"`,
          );
          await this.command("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Enter",
            code: "Enter",
          });
          await this.command("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Enter",
            code: "Enter",
          });
          await delay(1800);
        }
        state = await this.account(await this.inspect(), task.sender.address);
        const results = state.searchResults.filter((r) =>
          r.text.includes(task.subject),
        );
        if (results.length !== 1) return undefined;
        await this.click(results[0].position);
      }
      state = await this.account(await this.inspect(), task.sender.address);
      return state.messages.some(
        (m) =>
          m.from.toLowerCase() === task.sender.address.toLowerCase() &&
          m.body === task.body,
      )
        ? state.url
        : undefined;
    } catch {
      return undefined;
    }
  }
  private async checkReplies(account: string) {
    const conversations = await this.api.outreach<
      Array<{
        id: string;
        profileUrl: string | null;
        email: string | null;
        name: string;
        url: string | null;
        acceptedAt: string | null;
      }>
    >({ op: "conversations", sessionId: this.sessionId });
    for (const c of conversations) {
      if (this.stopped) break;
      const url =
        c.url ??
        (account.startsWith("https://www.linkedin.com/") ? c.profileUrl : null);
      if (!url) continue;
      this.progress(`Checking replies from ${c.name}`);
      await this.attach(url);
      let state = await this.account(await this.inspect(), account);
      const observations: BrowserObservation[] = [];
      if (
        state.site === "linkedin" &&
        c.profileUrl &&
        canonical(state.url) === canonical(c.profileUrl) &&
        state.connected &&
        !c.acceptedAt
      )
        observations.push({
          externalId: `accepted:${c.id}`,
          direction: "inbound",
          body: "Connection accepted",
          kind: "accepted",
          sentAt: new Date().toISOString(),
          conversationUrl: state.url,
        });
      if (state.site === "linkedin" && state.connected && state.message) {
        await this.click(state.message);
        state = await this.inspect();
      }
      const personUrl =
        state.site === "linkedin"
          ? (state.conversationProfile ??
            (canonical(state.url) === canonical(c.profileUrl ?? "")
              ? c.profileUrl
              : ""))
          : c.email;
      if (!personUrl) continue;
      if (
        state.site !== "linkedin" &&
        !state.messages.some(
          (m) =>
            m.from.toLowerCase() === account.toLowerCase() ||
            m.from.toLowerCase() === personUrl.toLowerCase(),
        )
      )
        continue;
      for (const m of state.messages) {
        const when = new Date(/^\d+$/.test(m.time) ? Number(m.time) : m.time);
        if (!Number.isFinite(when.getTime())) continue;
        const direction =
          canonical(m.from) === canonical(account) ? "outbound" : "inbound";
        if (
          direction === "inbound" &&
          canonical(m.from) !== canonical(personUrl)
        )
          continue;
        observations.push({
          externalId: m.id,
          direction,
          body: m.body,
          kind: /automatic reply|out of (?:the )?office/i.test(m.body)
            ? "automatic"
            : /delivery (?:failed|status notification)|undeliverable/i.test(
                  m.body,
                )
              ? "bounce"
              : "human",
          subject: state.site !== "linkedin" ? state.subject : undefined,
          sentAt: when.toISOString(),
          conversationUrl: state.url,
        });
      }
      await this.api.outreach({
        op: "observe",
        sessionId: this.sessionId,
        conversationId: c.id,
        account,
        personUrl,
        observations: observations.slice(-30),
      });
    }
  }
  async run(account: string) {
    try {
      await this.checkReplies(account);
      let lastChecked = Date.now();
      while (!this.stopped) {
        const task = await this.api.outreach<BrowserTask | null>({
          op: "next",
          sessionId: this.sessionId,
        });
        if (task) await this.send(task);
        else {
          this.progress("Queue is up to date. Checking for approved messages…");
          await delay(10000);
        }
        if (Date.now() - lastChecked > 300000) {
          await this.checkReplies(account);
          lastChecked = Date.now();
        }
      }
    } finally {
      if (this.tabId)
        await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
    }
  }
}
