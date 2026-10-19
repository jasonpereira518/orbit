import { expect, test, type Page } from "@playwright/test";
import { ensureOnboarded, untilHydrated } from "./helpers";

/**
 * Chat over the real /api/chat stream with the Gemini stub answering: ask, watch the answer
 * stream in, see the thread in the history rail, reload and reopen it, switch between two.
 * Pins the ChatPanel / useChatStream behaviour P8.4 moves. The stub names a thread after the
 * first words of its question, so two threads are told apart by their rail entries.
 */
const FIRST = "Alpha question about my network";
const SECOND = "Bravo question about my network";
const ANSWER = /Stub answer: your network/;

const rail = (page: Page) => page.getByRole("navigation", { name: "Chat history" });
const composer = (page: Page) => page.getByPlaceholder("Ask about your network…");

async function ask(page: Page, question: string) {
  const box = composer(page);
  const send = page.getByRole("button", { name: "Send", exact: true });
  await untilHydrated(
    async () => {
      await box.fill("");
      await box.fill(question);
    },
    () => expect(send).toBeEnabled({ timeout: 2_000 })
  );
  await send.click();
}

test("a question streams an answer and starts a thread in the history rail", async ({ page }) => {
  await ensureOnboarded(page);
  await page.goto("/chat");
  await ask(page, FIRST);

  await expect(page.getByText(FIRST).first()).toBeVisible();
  await expect(page.getByText(ANSWER)).toBeVisible({ timeout: 90_000 });
  // The stream is over once the stop control is gone.
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, { timeout: 30_000 });
  await expect(rail(page).getByRole("button", { name: /^Alpha question/ })).toBeVisible({ timeout: 30_000 });
});

test("a thread survives a reload and reopens from the rail, and a second thread can be switched to", async ({ page }) => {
  await page.goto("/chat");
  const alpha = rail(page).getByRole("button", { name: /^Alpha question/ });
  await expect(alpha).toBeVisible();

  // Reload: the saved thread is listed again and opens with its question and answer.
  await page.reload();
  await expect(alpha).toBeVisible();
  await untilHydrated(
    () => alpha.click(),
    () => expect(page.getByText(ANSWER)).toBeVisible({ timeout: 5_000 })
  );
  await expect(alpha).toHaveAttribute("aria-current", "true");
  await expect(page.getByText(FIRST).first()).toBeVisible();

  // A new chat starts empty; asking in it makes a second thread beside the first.
  // The rail has a labelled button and a collapsed-state icon twin; the visible one is the real control.
  await rail(page).getByRole("button", { name: "New chat", exact: true }).locator("visible=true").first().click();
  await expect(page.getByText(ANSWER)).toHaveCount(0);
  await ask(page, SECOND);
  await expect(page.getByText(ANSWER)).toBeVisible({ timeout: 90_000 });
  const bravo = rail(page).getByRole("button", { name: /^Bravo question/ });
  await expect(bravo).toBeVisible({ timeout: 30_000 });
  await expect(bravo).toHaveAttribute("aria-current", "true");

  // Switching back and forth swaps the transcript.
  await alpha.click();
  await expect(alpha).toHaveAttribute("aria-current", "true");
  await expect(page.getByText(FIRST).first()).toBeVisible();
  await expect(page.getByText(SECOND)).toHaveCount(0);
  await bravo.click();
  await expect(bravo).toHaveAttribute("aria-current", "true");
  await expect(page.getByText(SECOND).first()).toBeVisible();
  await expect(page.getByText(FIRST)).toHaveCount(0);
});

test("the floating ask bar streams an answer in place and files it as a thread", async ({ page }) => {
  const THIRD = "Charlie question from the bar";
  await page.goto("/dashboard");
  const bar = page.getByPlaceholder("Ask your network…");
  const ask = page.getByRole("button", { name: "Ask", exact: true });
  await untilHydrated(
    async () => {
      await bar.fill("");
      await bar.fill(THIRD);
    },
    () => expect(ask).toBeEnabled({ timeout: 2_000 })
  );
  await ask.click();
  await expect(page.getByText(ANSWER)).toBeVisible({ timeout: 90_000 });

  // The same conversation is in the history rail on /chat.
  await page.goto("/chat");
  await expect(rail(page).getByRole("button", { name: /^Charlie question/ })).toBeVisible({ timeout: 30_000 });
});
