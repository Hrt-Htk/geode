// #464: what one past version previews as. The kind and size come from the
// version's own decrypted metadata, so a binary never downloads its content and
// an image or note reuses the #463 reconstruct path. Obsidian-free.

import { decryptMetadata, type VaultKeys } from "../../core/crypto.ts";
import { b64decode, type VersionRecord } from "../../core/protocol.ts";
import { reconstructVersion } from "../sync/history-fetch.ts";
import { binaryPreviewLine, previewKind } from "./trash-format.ts";

export type VersionPreview =
  | { kind: "text"; text: string }
  | { kind: "image"; bytes: Uint8Array; mime: string }
  | { kind: "binary"; line: string };

export async function loadVersionPreview(
  record: VersionRecord,
  keys: VaultKeys,
  getBlob: (hash: string) => Promise<Uint8Array>,
): Promise<VersionPreview> {
  const meta = await decryptMetadata(b64decode(record.enc_metadata), keys, record.path_hash);
  const kind = previewKind(meta.path, meta.mime);
  if (kind === "binary") {
    return { kind, line: binaryPreviewLine(meta.path, meta.mime, meta.size) };
  }
  const { bytes } = await reconstructVersion(record, keys, getBlob);
  if (kind === "image") return { kind, bytes, mime: meta.mime };
  return { kind, text: new TextDecoder().decode(bytes) };
}
