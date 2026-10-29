// On-device plugin-state probe over CDP. Evaluates a JS expression in the
// Obsidian mobile WebView and prints the result: for reading Geode plugin
// state / logs on a real device without a full E2E.
//
// The CDP logic lives in test/e2e/phone-cdp.ts (shared with the phone E2E
// global setup's test-vault interlock and `deno task phone:cdp`); this file is
// the standalone Node CLI. Prefer `deno task phone:cdp -- "<js>"`: it takes
// the phone lock and finds+forwards the socket itself.
//
// CLI usage (assumes the webview devtools socket is already forwarded):
//   set -a; . .env.local; set +a    # ANDROID_SERIAL
//   WS=$ANDROID_SERIAL              # any device: its own wireless serial
//   SOCK=$(adb -s $WS shell "cat /proc/net/unix" | grep -o 'webview_devtools_remote_[0-9]*' | head -1)
//   adb -s $WS forward tcp:9444 localabstract:$SOCK
//   node cdp-eval.mjs 9444 "JSON.stringify({vault: app.vault.getName()})"
//
// Gotcha baked in (in phone-cdp.ts): in /json/list the page target's `id`
// appears BEFORE `type`, so parse the JSON. Node 24 type-strips the .ts import.

import { cdpEval } from "../../../test/e2e/phone-cdp.ts";

const [port, expr] = process.argv.slice(2);
cdpEval(Number(port), expr)
  .then((out) => {
    console.log(out);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
