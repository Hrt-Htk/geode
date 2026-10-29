import { assertFalse } from "@std/assert";
import { confirmNewVaultFromNotes } from "../../../plugin/ui/confirm-copy.ts";
import {
  FORGOT_CALLOUT_BODY,
  FORGOT_CALLOUT_TITLE,
  FORGOT_DEVICE_HINT,
  FORGOT_GOT_IT,
  FORGOT_NEW_VAULT,
  FORGOT_TITLE,
  FORGOT_TRY_AGAIN,
  PASSPHRASE_REQUIRED,
  UNLOCK_TITLE,
  UNLOCK_WORKING,
  WRONG_PASSPHRASE,
} from "../../../plugin/ui/passphrase-copy.ts";

// #440: unlock pop-up + forgot-passphrase copy.
// Owner rule: plain, concise, one line, NO hyphens or dashes of any kind.

const ALL_STRINGS = [
  UNLOCK_TITLE,
  UNLOCK_WORKING,
  PASSPHRASE_REQUIRED,
  WRONG_PASSPHRASE,
  FORGOT_TITLE,
  FORGOT_CALLOUT_TITLE,
  FORGOT_CALLOUT_BODY,
  FORGOT_DEVICE_HINT,
  FORGOT_GOT_IT,
  FORGOT_TRY_AGAIN,
  FORGOT_NEW_VAULT,
  confirmNewVaultFromNotes().title,
  confirmNewVaultFromNotes().message,
  confirmNewVaultFromNotes().confirmText,
];

Deno.test("passphrase copy: no hyphen, en dash, or em dash in any user-visible string", () => {
  for (const s of ALL_STRINGS) {
    assertFalse(/[\u2013\u2014-]/.test(s), `dashed string: ${s}`);
  }
});
