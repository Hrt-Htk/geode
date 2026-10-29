const NOUNS = [
  "Otter",
  "Cactus",
  "Comet",
  "Falcon",
  "Badger",
  "Juniper",
  "Lantern",
  "Marmot",
  "Pebble",
  "Quill",
  "Raven",
  "Sable",
  "Tundra",
  "Vesper",
  "Willow",
  "Zephyr",
];

export function generateDeviceName(isMobile: boolean): string {
  const prefix = isMobile ? "Mobile" : "Desktop";
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${prefix} ${noun}`;
}

export function validateDeviceName(raw: string):
  | { ok: true; name: string }
  | { ok: false; error: string } {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, error: "Enter a device name." };
  if (name.length > 64) return { ok: false, error: "Device name is too long (max 64 characters)." };
  return { ok: true, name };
}
