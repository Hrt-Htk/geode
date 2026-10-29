import { expect } from "@playwright/test";
import { evalClick, evalSetValue, type MobileUI } from "./mobile-ui";

// #677: the admin token prompt (`plugin/ui/admin-token-modal.ts`): asked for a device
// revoke and for a trash purge inside the server's retention floor. The E2E server
// fixture runs with this admin token. Driven in-page so desktop and phone share it.

export const E2E_ADMIN_TOKEN = "e2e";

const INPUT = '[data-testid="geode-admin-token-input"]';
const CONTINUE = '[data-testid="geode-admin-token-continue"]';

/** Wait for the prompt, fill the admin token, continue. The fixture throwaway server
 * runs with this same "e2e" admin token, so loopback phone/hybrid runs use the default. */
export async function enterAdminToken(ui: MobileUI, token = E2E_ADMIN_TOKEN): Promise<void> {
  await expect
    .poll(() => ui.eval(`!!document.querySelector(${JSON.stringify(INPUT)})`), { timeout: 20_000 })
    .toBe(true);
  await evalSetValue(ui, INPUT, token);
  await evalClick(ui, CONTINUE);
}
