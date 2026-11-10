/** The four control rows' names (#16). Obsidian renders control rows on 1.13+, so the rows cannot
 * carry a testid there and the E2E drives them by name: a rename breaks the specs at compile time.
 * `obsidian`-free, so the specs can import them. */
export const AUTO_LOCK_ROW = "Auto lock after (hours)";
export const TRASH_RETENTION_ROW = "Trash retention (days)";
export const DEVELOPER_CONSOLE_ROW = "Developer console";
export const SYNC_CONFIG_ROW = "Sync config folder";
