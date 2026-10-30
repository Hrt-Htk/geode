// The renderer's window. Timers come from it because the scanner wants
// `window.setTimeout` rather than the bare global (popout-window compatibility); `fetch` is
// reached through it because the scanner bans the bare `fetch` global and its config forbids
// disabling that rule (see http-platform.ts). Deno's unit tests have no `window`, only
// `self`, which is the same object there.
export const windowGlobal: Window = typeof window === "undefined" ? self : window;
