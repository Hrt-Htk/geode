export function normalizePath(path: string): string {
  return path
    .normalize("NFC")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .trim();
}

export function normalizeMarkdownLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function stripBOM(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function isMarkdownPath(path: string): boolean {
  return path.endsWith(".md") || path.endsWith(".markdown");
}

// Single source of truth for a file's identity-hash input: markdown is
// normalized (BOM strip + EOL) before hashing; everything else is hashed raw.
export function normalizeForHash(path: string, bytes: Uint8Array): Uint8Array {
  return isMarkdownPath(path)
    ? new TextEncoder().encode(
      normalizeMarkdownLineEndings(stripBOM(new TextDecoder().decode(bytes))),
    )
    : bytes;
}

export function detectMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "md":
    case "markdown":
      return "text/markdown";
    case "txt":
      return "text/plain";
    case "json":
      return "application/json";
    case "canvas":
      return "application/json";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}
