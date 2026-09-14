/** Runs inside the selected provider tab. No credentials or arbitrary model code. */
export function inspectOutreachPage() {
  const visible = (e: Element) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const pos = (e: Element | null) => {
    if (!e || !visible(e)) return null;
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const all = (selector: string) =>
    Array.from(document.querySelectorAll(selector)).filter(visible);
  const buttons = all('button,[role="button"],a').map((e) => ({
    text: (e.getAttribute("aria-label") || e.textContent || "").trim(),
    ...pos(e),
  }));
  const find = (regex: RegExp) =>
    buttons.find((b) => regex.test(b.text)) ?? null;
  const text = document.body.innerText;
  const host = location.hostname;
  const site = host.includes("linkedin")
    ? "linkedin"
    : host === "mail.google.com"
      ? "gmail"
      : "outlook";
  const accountElements = all(
    '[aria-label*="Google Account"],[data-testid="meControl"],[id*="MeControl"],[aria-label*="Account manager"],[title*="Account manager"]',
  );
  const accountText = accountElements
    .map(
      (e) =>
        `${e.getAttribute("aria-label")} ${e.getAttribute("title")} ${e.textContent}`,
    )
    .join(" ");
  const email =
    accountText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
  const ownProfile = Array.from(
    document.querySelectorAll(
      'nav a[href*="/in/"],.global-nav__me-content a[href*="/in/"],a.global-nav__me-photo',
    ),
  )
    .map((e) => e.getAttribute("href"))
    .find(Boolean);
  const bodyEl =
    site === "gmail"
      ? all('[contenteditable="true"][role="textbox"]').find((e) =>
          /message body/i.test(e.getAttribute("aria-label") ?? ""),
        )
      : site === "linkedin"
        ? all(
            'textarea[name="message"],textarea#custom-message,.msg-form__contenteditable',
          ).at(-1)
        : all('[contenteditable="true"][role="textbox"]').find((e) =>
            /message body/i.test(e.getAttribute("aria-label") ?? ""),
          );
  const subjectEl = all(
    'input[name="subjectbox"],input[placeholder="Add a subject"],input[aria-label="Subject"]',
  ).at(-1) as HTMLInputElement | undefined;
  const composer = bodyEl?.closest(
    '[role="dialog"],form,.M9,.ip,[data-testid="compose-window"]',
  );
  const recipientElements = composer
    ? Array.from(
        composer.querySelectorAll(
          site === "gmail"
            ? '[email],[data-hovercard-id],input[name="to"],input[name="cc"],input[name="bcc"]'
            : '[data-email],[title*="@"],[aria-label*="@"]',
        ),
      ).filter((e) => visible(e) && !bodyEl?.contains(e))
    : [];
  const recipients = [
    ...new Set(
      recipientElements.flatMap((e) => {
        const value =
          e.getAttribute("email") ??
          e.getAttribute("data-hovercard-id") ??
          e.getAttribute("data-email") ??
          (e instanceof HTMLInputElement
            ? e.value
            : (e.getAttribute("title") ?? e.getAttribute("aria-label") ?? ""));
        return (
          value
            .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)
            ?.map((s) => s.toLowerCase()) ?? []
        );
      }),
    ),
  ];
  const dialog = all('[role="dialog"]').at(-1);
  const conversationProfile = all(
    '.msg-thread__link-to-profile,.msg-overlay-bubble-header a[href*="/in/"]',
  )
    .map((e) => e.getAttribute("href"))
    .find(Boolean);
  const messages = all(
    site === "linkedin"
      ? ".msg-s-event-listitem"
      : site === "gmail"
        ? ".adn"
        : "[data-message-id]",
  )
    .map((e) => {
      const from =
        e.querySelector("[email]")?.getAttribute("email") ??
        e.querySelector("[data-email]")?.getAttribute("data-email") ??
        e.querySelector('a[href*="/in/"]')?.getAttribute("href") ??
        "";
      const time =
        e.querySelector("time")?.getAttribute("datetime") ??
        e.querySelector("[data-timestamp]")?.getAttribute("data-timestamp") ??
        e.querySelector(".g3[title]")?.getAttribute("title") ??
        "";
      const body =
        e
          .querySelector(
            '.msg-s-event-listitem__body,.a3s,[data-testid="messageBody"]',
          )
          ?.textContent?.trim() ?? "";
      return {
        id:
          e.getAttribute("data-message-id") ??
          e.getAttribute("data-event-urn") ??
          e
            .querySelector("[data-message-id]")
            ?.getAttribute("data-message-id") ??
          e.id,
        from,
        time,
        body,
      };
    })
    .filter((m) => m.id && m.body && m.time);
  return {
    site,
    url: location.href,
    account:
      site === "linkedin"
        ? ownProfile
          ? new URL(ownProfile, location.origin).href
          : null
        : email,
    accountButton: find(/^(Me|Account manager|Google Account)/i),
    blocked:
      /unusual activity|verify your identity|security verification|invitation limit reached|temporarily restricted|captcha/i.test(
        text,
      ),
    login:
      /Sign in to LinkedIn|Sign in to your account|Enter your password/.test(
        text,
      ),
    body:
      bodyEl instanceof HTMLTextAreaElement
        ? bodyEl.value
        : ((bodyEl as HTMLElement | undefined)?.innerText ?? ""),
    bodyPosition: pos(bodyEl ?? null),
    subject:
      subjectEl?.value ??
      all('h2.hP,[data-testid="conversation-subject"]')
        .at(0)
        ?.textContent?.trim() ??
      "",
    subjectPosition: pos(subjectEl ?? null),
    recipients,
    dialogText: dialog?.textContent ?? "",
    conversationProfile,
    messages,
    reply: find(/^(Reply|Reply to sender)$/),
    viewMessage: find(/^View message$/),
    searchPosition: pos(
      all(
        'input[placeholder="Search mail"],input[aria-label="Search mail"],input[placeholder="Search"],input[aria-label="Search"]',
      ).at(0) ?? null,
    ),
    searchResults: all('tr.zA,[role="option"][data-convid]').map((e) => ({
      text: e.textContent ?? "",
      position: pos(e),
    })),
    connect: find(/^(Connect|Invite .* to connect)$/),
    addNote: find(/^Add a note$/),
    send: composer
      ? (Array.from(composer.querySelectorAll('button,[role="button"]'))
          .filter(visible)
          .map((e) => ({
            text: e.getAttribute("aria-label") || e.textContent || "",
            ...pos(e),
          }))
          .find((b) => /^(Send|Send invitation|Send now)(\s|$)/.test(b.text)) ??
        null)
      : site === "linkedin"
        ? find(/^(Send|Send invitation|Send now)(\s|$)/)
        : null,
    message: find(/^Message$/),
    pending: all('main button,[role="dialog"] button').some((e) =>
      /^Pending$/.test(e.textContent?.trim() ?? ""),
    ),
    confirmed:
      site === "gmail"
        ? /Message sent/.test(text)
        : site === "outlook"
          ? /Message sent|Your message has been sent/.test(text)
          : false,
    connected:
      site === "linkedin" &&
      all('main .dist-value,main [class*="distance-badge"]').some((e) =>
        /1st/.test(e.textContent ?? ""),
      ),
  };
}
export type PageState = ReturnType<typeof inspectOutreachPage>;
