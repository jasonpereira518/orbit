import type { ExtensionFeature } from "@contract";
import type { OrbitApi } from "./api";
import { browser } from "./browser";
import { APP_URL } from "./env";

/**
 * The user clicked a locked Pro section. That click — not the section being on
 * screen — is the demand signal, so it is recorded (the server throttles it to
 * once a day), and then pricing opens, told which feature brought them.
 *
 * Pricing opens even if recording fails: losing one data point must never cost
 * the user the page they asked for.
 */
export async function unlockFeature(api: OrbitApi, feature: ExtensionFeature) {
  const fallback = `${APP_URL}/pricing?from=extension&feature=${feature}`;
  try {
    const { upgradeUrl } = await api.gate({ feature });
    browser().openTab(upgradeUrl || fallback);
  } catch {
    browser().openTab(fallback);
  }
}
