/** Decide whether to adopt the server-provided vault name from the handshake.
 * The server is the source of truth for the vault name. Returns the name to
 * persist, or `null` when nothing should change (empty/undefined received, or
 * the received name already equals the current one). */
export function reconcileVaultName(
  current: string,
  received: string | undefined,
): string | null {
  if (!received) return null;
  if (received === current) return null;
  return received;
}
