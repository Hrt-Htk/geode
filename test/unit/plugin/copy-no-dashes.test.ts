import { assertEquals } from "@std/assert";
import {
  confirmKeepVersion,
  confirmLeaveVault,
  confirmNewVaultFromNotes,
  confirmPurgeExpired,
  confirmPurgeFile,
  confirmPurgeSelected,
  confirmRestoreVersion,
  confirmResyncFromScratch,
  confirmRevokeDevice,
  validateVaultName,
} from "../../../plugin/ui/confirm-copy.ts";
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
import {
  binaryPreviewLine,
  deletedFromLabel,
  deviceNameLabel,
  fileTypeLabel,
  formatBytes,
  IN_FLOOR_PURGE_ASK,
  IN_FLOOR_PURGE_CANCELLED,
  IN_FLOOR_PURGE_TITLE,
  keptLabel,
  plural,
  previewFetches,
  previewKind,
  PURGE_HISTORY_FAILED,
  purgedExpiredNotice,
  purgedOneNotice,
  purgedSelectedNotice,
  relativeTime,
  restoredNotice,
  restoredOneNotice,
  retentionLabel,
  shortPathHash,
  trashCountLabel,
  trashEntryLabel,
} from "../../../plugin/ui/trash-format.ts";
import { describeSyncStatus, type SyncStatusInput } from "../../../plugin/ui/sync-status.ts";
import { describeStorage, type StorageState } from "../../../plugin/ui/storage-status.ts";
import { describeErrorBanner } from "../../../plugin/ui/sync-banner.ts";
import {
  confirmMessage as massDeleteConfirmMessage,
  confirmTitle as massDeleteConfirmTitle,
  filesMissing,
  formatDay as massDeleteFormatDay,
  holdNoticeText,
  holdSentence,
  mainAction,
  trashNote,
} from "../../../plugin/ui/mass-delete-review.ts";
import { buildStatusMenu } from "../../../plugin/ui/status-menu.ts";
import {
  deviceDescText,
  devicesSummaryText,
  deviceStatusText,
  ROTATE_ADMIN_TOKEN_DESC,
  ROTATE_ADMIN_TOKEN_NAME,
} from "../../../plugin/ui/device-status.ts";
import { connectionLabel, LOG_FILTERS, logDetailsText } from "../../../plugin/ui/log-format.ts";
import { generateDeviceName, validateDeviceName } from "../../../plugin/ui/device-name.ts";
import {
  rejoinFailedNotice,
  rejoinResultText,
  rejoinWarningText,
  serverErrorText,
  STRENGTH_DETAIL,
  STRENGTH_NOTE,
  STRENGTH_OPTIONS,
  validateCreateForm,
  wizardTitle,
} from "../../../plugin/ui/setup-wizard-logic.ts";
import { CONFIG_CATEGORIES, configSummary } from "../../../plugin/ui/config-scope.ts";
import {
  NOT_SET_UP_SETUP_DESC,
  NOT_SET_UP_SETUP_NAME,
  NOT_SET_UP_STATUS_TEXT,
} from "../../../plugin/ui/tab-state.ts";
import { pauseAgeLabel, pauseTooltip } from "../../../plugin/ui/pause.ts";
import {
  buildHistory,
  eventLabel,
  gapLabel,
  periodLabel,
  savesLabel,
  timeLabel,
} from "../../../plugin/ui/history-periods.ts";
import {
  BACK_BUTTON,
  DIFF_CAPTION,
  DONE_BUTTON as HISTORY_DONE_BUTTON,
  EMPTY_DESC,
  EMPTY_TITLE,
  ERROR_TEXT,
  HISTORY_ENTRY_TITLE,
  historySubtitle,
  historyTitle,
  LOADING_TEXT,
  markerLabel,
  NAME_CAPPED_TEXT,
  OLDER_BUTTON,
  OLDER_ERROR_TEXT,
  previewCaption,
  previewState,
  RESTORE_BUSY_NOTICE,
  RESTORE_BUTTON,
  RESTORE_FAILED_NOTICE,
  RESTORE_NOTICE,
  RESTORE_PAUSED_NOTICE,
  RESTORE_UNCHANGED_NOTICE,
  RESTORE_UNSYNCED_NOTICE,
  RETRY_BUTTON as HISTORY_RETRY_BUTTON,
} from "../../../plugin/ui/history-view.ts";
import {
  reconnectNotice,
  serverAddressCheckMessage,
  serverAddressError,
} from "../../../plugin/plumbing/server-address.ts";
import { blockedCopy, describeVersionHint } from "../../../plugin/sync/version-state.ts";
import { copySpaceCheck, formatEta, liveEta } from "../../../plugin/ui/rekey-estimate.ts";
import {
  CANCEL_BUTTON,
  CHANGE_ROW_BUTTON,
  CHANGE_WARNING,
  CHECKBOX_CHANGE,
  CHECKBOX_REKEY,
  CONFIRM_PASSPHRASE_LABEL,
  CONTINUE_BUTTON,
  COPY_OPTION_DESC,
  COPY_OPTION_NAME,
  CURRENT_PASSPHRASE_LABEL,
  DONE_BUTTON,
  ESTIMATING,
  KEEP_OPEN_LINE,
  NEW_PASSPHRASE_LABEL,
  PASSPHRASE_ROW_DESC,
  PASSPHRASE_ROW_NAME,
  PAUSE_BUTTON,
  PAUSED_LINE,
  REKEY_ROW_BUTTON,
  REKEY_TITLES,
  REKEY_WARNING,
  rekeyFormHint,
  rekeyProgressLine,
  rekeySubmitError,
  REPLACE_OPTION_DESC,
  REPLACE_OPTION_NAME,
  RESUME_BUTTON,
  RESUME_FORM_TITLE,
  RESUME_ROW_BUTTON,
  RESUME_ROW_DESC,
  RETRY_BUTTON,
  RUN_TITLE,
  SAVE_FAILED_LINE,
  START_BUTTON,
  STRENGTH_CUSTOM,
  STRENGTH_ROW_NAME,
  SUCCESS_LINES,
  SUCCESS_SUBLINE,
} from "../../../plugin/ui/rekey-modal-logic.ts";
import { rekeyChoice } from "../../../plugin/ui/rekey-estimate.ts";

// #479: the owner copy rule: every user-visible string is plain, one line, and
// carries no hyphens or dashes of any kind. This test scans the copy modules'
// output so a dash sneaking back into any of them fails CI.

const DASHES = /[\u2010-\u2015\u2212-]/;

function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") {
    out.push(v);
    return out;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, out);
    return out;
  }
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) collectStrings(x, out);
  }
  return out;
}

function assertNoDashes(label: string, ...values: unknown[]): void {
  for (const s of collectStrings(values)) {
    assertEquals(DASHES.test(s), false, `${label} produced "${s}"`);
  }
}

Deno.test("copy-no-dashes - confirm dialogs and vault-name errors", () => {
  assertNoDashes("confirm-copy", [
    validateVaultName(""),
    validateVaultName("   "),
    validateVaultName("x".repeat(65)),
    confirmLeaveVault("Test Vault"),
    confirmResyncFromScratch(),
    confirmPurgeFile("Daily/note.md"),
    confirmPurgeExpired(1),
    confirmPurgeExpired(3),
    confirmPurgeSelected(2),
    confirmNewVaultFromNotes(),
    confirmKeepVersion("Phone", "This laptop"),
    confirmRevokeDevice("Phone"),
    // #465: the restore confirm and its outcome notices.
    confirmRestoreVersion(),
  ]);
});

Deno.test("copy-no-dashes - passphrase and forgot-passphrase copy", () => {
  assertNoDashes("passphrase-copy", [
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
  ]);
});

Deno.test("copy-no-dashes - trash formatting", () => {
  const now = 1_000_000_000;
  assertNoDashes("trash-format", [
    relativeTime(now - 30, now),
    relativeTime(now - 5 * 60, now),
    relativeTime(now - 3 * 3600, now),
    relativeTime(now - 4 * 86400, now),
    shortPathHash("abc123456789def0"),
    trashEntryLabel({ path: "Notes/a.md", path_hash: "h" }),
    trashCountLabel({ status: "loading" }),
    trashCountLabel({ status: "error" }),
    trashCountLabel({ status: "loaded", count: 2 }),
    deletedFromLabel(now - 2 * 86400, "Phone", now),
    deviceNameLabel("d1"),
    retentionLabel(now - 2 * 86400, 30, now),
    retentionLabel(now - 40 * 86400, 30, now),
    keptLabel(1),
    keptLabel(28),
    formatBytes(512),
    formatBytes(2 * 1024),
    formatBytes(2.5 * 1024 * 1024),
    plural(1, "file"),
    plural(3, "file"),
    previewKind("a.md", "text/markdown"),
    previewKind("pic.png", "image/png"),
    previewKind("video.mp4", ""),
    previewFetches("text", 1),
    previewFetches("binary", 0),
    fileTypeLabel("a.md", "text/markdown"),
    fileTypeLabel("video.mp4", ""),
    binaryPreviewLine("a.pdf", "application/pdf", 240 * 1024),
    binaryPreviewLine("a.bin", ""),
    restoredNotice(2),
    restoredOneNotice("a.md"),
    purgedExpiredNotice(2),
    purgedOneNotice("a.md"),
    PURGE_HISTORY_FAILED,
    purgedSelectedNotice(2),
    IN_FLOOR_PURGE_TITLE,
    IN_FLOOR_PURGE_ASK,
    IN_FLOOR_PURGE_CANCELLED,
  ]);
});

Deno.test("copy-no-dashes - sync status row text across states", () => {
  const base: SyncStatusInput = {
    unlocked: true,
    versionStatus: { kind: "ok" },
    conflictCount: 0,
    state: "live",
    pendingCount: 0,
    dirtyCount: 0,
    lastSyncTime: 0,
    syncingProgress: null,
    reconnectDelay: 0,
    offlineSince: 0,
    lastAttemptAt: 0,
    droppedCount: 0,
    pausedAt: 0,
    massDeleteHold: null,
    lastBackupAt: 0,
  };
  const now = 1_000_000_000;
  assertNoDashes("sync-status", [
    describeSyncStatus({ ...base, unlocked: false }, now),
    describeSyncStatus({ ...base, pausedAt: now - 60_000 }, now),
    describeSyncStatus({ ...base, versionStatus: { kind: "blocked", side: "plugin" } }, now),
    describeSyncStatus({ ...base, versionStatus: { kind: "blocked", side: "server" } }, now),
    describeSyncStatus({ ...base, conflictCount: 2 }, now),
    describeSyncStatus({ ...base, syncingProgress: { current: 1, total: 3 } }, now),
    describeSyncStatus({ ...base, state: "syncing" }, now),
    describeSyncStatus({ ...base, state: "disconnected", reconnectDelay: 5000 }, now),
    describeSyncStatus({ ...base, state: "connecting" }, now),
    describeSyncStatus({ ...base, pendingCount: 2 }, now),
    describeSyncStatus({ ...base, droppedCount: 1 }, now),
    describeSyncStatus({ ...base, lastBackupAt: now - 300_000 }, now),
    // #560: re-key states: paused while a re-key runs elsewhere, and the
    // locked "passphrase changed elsewhere" state after it commits.
    describeSyncStatus({ ...base, rekeyInProgress: true }, now),
    // #601: the held mass delete names the hold in the settings status row.
    describeSyncStatus({
      ...base,
      massDeleteHold: { files: [{ path: "a.md", mtime: 1 }], totalTracked: 10, detectedAt: 5 },
    }, now),
    describeSyncStatus({ ...base, unlocked: false, rekeyElsewhere: true }, now),
  ]);
});

Deno.test("copy-no-dashes - storage row text", () => {
  const states: StorageState[] = [
    { kind: "loading" },
    { kind: "unavailable" },
    { kind: "data", total: 100 * 1024 ** 3, free: 0, used: 100 * 1024 ** 3 },
    { kind: "data", total: 100 * 1024 ** 3, free: 5 * 1024 ** 3, used: 95 * 1024 ** 3 },
    { kind: "data", total: 100 * 1024 ** 3, free: 50 * 1024 ** 3, used: 50 * 1024 ** 3 },
  ];
  assertNoDashes("storage-status", states.map(describeStorage));
});

Deno.test("copy-no-dashes - sync error banner", () => {
  const base: SyncStatusInput = {
    unlocked: true,
    versionStatus: { kind: "ok" },
    conflictCount: 0,
    state: "live",
    pendingCount: 0,
    dirtyCount: 0,
    lastSyncTime: 0,
    syncingProgress: null,
    reconnectDelay: 0,
    offlineSince: 0,
    lastAttemptAt: 0,
    droppedCount: 0,
    pausedAt: 0,
    lastBackupAt: 0,
  };
  const now = 1_000_000_000;
  assertNoDashes("sync-banner", [
    describeErrorBanner(
      { ...base, offlineSince: now - 60_000, lastAttemptAt: now - 2000 },
      now,
      "https://geode.example.org",
    ),
    describeErrorBanner({ ...base, droppedCount: 3 }, now, "https://geode.example.org"),
    describeErrorBanner({ ...base, droppedCount: 1 }, now, "https://geode.example.org"),
  ]);
});

Deno.test("copy-no-dashes - status menu labels", () => {
  assertNoDashes(
    "status-menu",
    buildStatusMenu({ unlocked: true, configured: true, paused: false, conflictCount: 3 }).map((
      i,
    ) => i.label),
  );
});

Deno.test("copy-no-dashes - device status text", () => {
  assertNoDashes("device-status", [
    deviceStatusText(null, 10),
    deviceStatusText(10, 10),
    deviceStatusText(7, 10),
    deviceDescText({ lastSeenAt: 1_000, appliedSeq: 7, headSeq: 10 }, (s) => relativeTime(s)),
    devicesSummaryText([{ appliedSeq: null, headSeq: 10 }, { appliedSeq: 7, headSeq: 10 }, {
      appliedSeq: 10,
      headSeq: 10,
    }]),
    ROTATE_ADMIN_TOKEN_NAME,
    ROTATE_ADMIN_TOKEN_DESC,
  ]);
});

Deno.test("copy-no-dashes - log labels (not log lines)", () => {
  assertNoDashes("log-format", [
    LOG_FILTERS.map((f) => f.label),
    connectionLabel("live"),
    connectionLabel("connecting"),
    connectionLabel("blocked"),
    connectionLabel("disconnected"),
    logDetailsText({ state: "Connected", seq: 1284, pending: 2 }),
  ]);
});

Deno.test("copy-no-dashes - generated device names and validation", () => {
  assertNoDashes("device-name", [
    generateDeviceName(false),
    generateDeviceName(true),
    validateDeviceName(""),
    validateDeviceName("x".repeat(65)),
  ]);
});

Deno.test("copy-no-dashes - setup wizard copy", () => {
  assertNoDashes("setup-wizard", [
    Object.values(STRENGTH_OPTIONS),
    Object.values(STRENGTH_DETAIL),
    STRENGTH_NOTE,
    wizardTitle(null),
    wizardTitle("create"),
    wizardTitle("join"),
    validateCreateForm({ vaultName: "", passphrase: "", confirm: "" }),
    validateCreateForm({ vaultName: "v", passphrase: "a", confirm: "b" }),
    validateCreateForm({ vaultName: "v", passphrase: "short", confirm: "short" }),
    serverErrorText("invalid-token", "geode.example.org"),
    serverErrorText("server-error", "geode.example.org"),
    serverErrorText("unreachable", "geode.example.org"),
    // #701: the rejoin warning, its report and the failed join notice.
    rejoinWarningText(),
    rejoinFailedNotice(),
    rejoinResultText(1, "Geode backup/2026.10.29 14.06.42"),
    rejoinResultText(12, "Geode backup/2026.10.29 14.06.42"),
  ]);
});

Deno.test("copy-no-dashes - config categories and summary", () => {
  assertNoDashes("config-scope", [
    CONFIG_CATEGORIES.map((c) => c.name),
    configSummary([], 0, 0),
    configSummary([], 2, 3),
    configSummary(["appearance"], 2, 3),
  ]);
});

Deno.test("copy-no-dashes - tab-state not-set-up copy", () => {
  assertNoDashes("tab-state", [
    NOT_SET_UP_STATUS_TEXT,
    NOT_SET_UP_SETUP_NAME,
    NOT_SET_UP_SETUP_DESC,
  ]);
});

Deno.test("copy-no-dashes - pause copy", () => {
  const now = 1_000_000_000;
  assertNoDashes("pause", [
    pauseAgeLabel(now - 30_000, now),
    pauseAgeLabel(now - 5 * 60_000, now),
    pauseAgeLabel(now - 2 * 3600_000, now),
    pauseTooltip(now - 5 * 60_000, now),
  ]);
});

Deno.test("copy-no-dashes - server address copy", () => {
  assertNoDashes("server-address", [
    serverAddressError("empty"),
    serverAddressError("not-a-url"),
    serverAddressCheckMessage("unreachable", "https://geode.example.org"),
    serverAddressCheckMessage("no-vault", "https://geode.example.org"),
    serverAddressCheckMessage("device-unknown", "https://geode.example.org"),
    serverAddressCheckMessage("vault-mismatch", "https://geode.example.org"),
    reconnectNotice("https://geode.example.org"),
  ]);
});

Deno.test("copy-no-dashes - blocked copy, both sides (#625)", () => {
  for (const side of ["plugin", "server"] as const) {
    const copy = blockedCopy(side);
    assertNoDashes("version-state", [
      copy.title,
      copy.notice,
      copy.bannerDesc,
      copy.tooltip,
      copy.row,
    ]);
  }
});

Deno.test("copy-no-dashes - update hints (#529)", () => {
  assertNoDashes("version-state", describeVersionHint("0.5.0", "0.9.2"));
  assertNoDashes("version-state", describeVersionHint("0.9.2", "0.5.0"));
});

Deno.test("copy-no-dashes - rekey modal copy (#559)", () => {
  assertNoDashes("rekey-modal", [
    REKEY_TITLES.change,
    REKEY_TITLES.rekey,
    CURRENT_PASSPHRASE_LABEL,
    NEW_PASSPHRASE_LABEL,
    CONFIRM_PASSPHRASE_LABEL,
    CHANGE_WARNING,
    REKEY_WARNING,
    CHECKBOX_CHANGE,
    CHECKBOX_REKEY,
    COPY_OPTION_NAME,
    COPY_OPTION_DESC,
    REPLACE_OPTION_NAME,
    REPLACE_OPTION_DESC,
    ESTIMATING,
    START_BUTTON,
    CONTINUE_BUTTON,
    RUN_TITLE,
    KEEP_OPEN_LINE,
    PAUSE_BUTTON,
    RESUME_BUTTON,
    CANCEL_BUTTON,
    RETRY_BUTTON,
    DONE_BUTTON,
    PAUSED_LINE,
    RESUME_FORM_TITLE,
    SAVE_FAILED_LINE,
    SUCCESS_LINES.change,
    SUCCESS_LINES.rekey,
    SUCCESS_SUBLINE,
    PASSPHRASE_ROW_NAME,
    PASSPHRASE_ROW_DESC,
    CHANGE_ROW_BUTTON,
    RESUME_ROW_BUTTON,
    REKEY_ROW_BUTTON,
    RESUME_ROW_DESC,
    STRENGTH_ROW_NAME,
    STRENGTH_CUSTOM,
    rekeySubmitError("change", { current: "", next: "a", confirm: "a", level: "standard" }),
    rekeySubmitError("change", {
      current: "x",
      next: "short",
      confirm: "short",
      level: "standard",
    }),
    rekeyFormHint("change", { current: "x", next: "a", confirm: "b", level: "standard" }),
    rekeyProgressLine("blobs", 38, 100, "About 4:32 left"),
    rekeyProgressLine("blobs", 38, 100, null),
    rekeyProgressLine("rows", 72, 100, null),
    rekeyProgressLine("switch", 0, 1, null),
    rekeyChoice({ ok: false, reason: "Not enough free space on the server." }).copy.reason,
  ]);
});

Deno.test("copy-no-dashes - rekey estimate copy (#558)", () => {
  assertNoDashes("rekey-estimate", [
    formatEta(0),
    formatEta(45),
    formatEta(60),
    formatEta(900),
    formatEta(7200),
    formatEta(Infinity),
    liveEta(0, 1000, 100),
    liveEta(900, 1000, 100),
    liveEta(1000, 1000, 100),
    (copySpaceCheck({ vaultBytes: 1024 ** 3, serverFree: null }) as { reason: string }).reason,
    (copySpaceCheck({ vaultBytes: 1024 ** 3, serverFree: 10 }) as { reason: string }).reason,
  ]);
});

Deno.test("copy-no-dashes - file history periods (#462)", () => {
  const names = new Map([["d-laptop", "This laptop"], ["d-phone", "Phone"]]);
  const at = (day: number, hour: number, minute: number) =>
    new Date(2026, 4, day, hour, minute).getTime();
  const row = (
    version: number,
    created: number,
    deviceId: string,
    compacted: string | null = null,
    restored = false,
    deleted = 0,
  ) => ({
    version,
    created_at: created,
    device_id: deviceId,
    compacted_range: compacted,
    restored,
    deleted,
    rename_mark: 0,
  });
  // Laptop and phone periods, a deletion, a restore, a compacted fold and a rename marker.
  const items = buildHistory([
    {
      pathHash: "hash-a",
      from: "Notes/Old name.md",
      versions: [
        row(7, at(12, 14, 6), "d-laptop", null, true),
        row(6, at(12, 14, 2), "d-laptop", null, false, 1), // the deletion tombstones v6
        row(5, at(12, 13, 52), "d-phone", "4-5"),
        row(3, at(12, 13, 40), "d-phone"),
      ],
    },
    {
      pathHash: "hash-b",
      from: null,
      versions: [row(2, at(12, 13, 35), "d-laptop"), row(1, at(11, 9, 5), "d-laptop")],
    },
  ], names);
  const rendered = items.map((i) => {
    if (i.kind === "marker") return markerLabel(i.from);
    if (i.kind === "event") return eventLabel(i, at(12, 18, 0));
    return i.kind === "period" ? periodLabel(i, at(12, 18, 0)) : gapLabel();
  });
  const saveRows = items.flatMap((i) =>
    i.kind !== "period" ? [] : i.saves.map((save) => timeLabel(save.at))
  );
  assertNoDashes("history-periods", [
    ...rendered,
    ...saveRows,
    // #687: a device the vault never saw is not named.
    eventLabel({
      kind: "event",
      event: "restored",
      device: null,
      at: at(12, 9, 5),
      key: "k",
      version: 1,
    }, at(12, 18, 0)),
    eventLabel({
      kind: "event",
      event: "deleted",
      device: null,
      at: at(12, 9, 5),
      key: "k",
      version: 1,
    }, at(12, 18, 0)),
    savesLabel(1),
    savesLabel(9),
    timeLabel(at(12, 9, 5)),
  ]);
});

Deno.test("copy-no-dashes - file history modal (#464)", () => {
  const at = (day: number, hour: number, minute: number) =>
    new Date(2026, 4, day, hour, minute).getTime();
  const view = {
    expanded: new Set<number>(),
    selected: 1,
    showDiff: false,
    shown: 4,
    pane: "list" as const,
  };
  assertNoDashes("history-view", [
    HISTORY_ENTRY_TITLE,
    OLDER_BUTTON,
    OLDER_ERROR_TEXT,
    HISTORY_RETRY_BUTTON,
    BACK_BUTTON,
    HISTORY_DONE_BUTTON,
    LOADING_TEXT,
    ERROR_TEXT,
    EMPTY_TITLE,
    EMPTY_DESC,
    DIFF_CAPTION,
    historyTitle("Notes/Meeting notes.md"),
    historySubtitle("Notes/Meeting notes.md", "This laptop"),
    historySubtitle("Meeting notes.md", "This laptop"),
    previewCaption({ at: at(12, 14, 20), device: "Phone", event: null }),
    // #691: a restore row's preview caption carries the row's words.
    previewCaption({ at: at(12, 14, 20), device: "Phone", event: "restored" }),
    previewState(view, "text").toggle,
    previewState({ ...view, showDiff: true }, "text").toggle,
    // #583: the marker row between two names, and a window capped by a trash row.
    markerLabel("Notes/Old name.md"),
    markerLabel("Meeting notes.md"),
    NAME_CAPPED_TEXT,
    RESTORE_BUTTON,
    RESTORE_NOTICE,
    RESTORE_UNCHANGED_NOTICE,
    RESTORE_FAILED_NOTICE,
    RESTORE_BUSY_NOTICE,
    RESTORE_PAUSED_NOTICE,
    RESTORE_UNSYNCED_NOTICE,
  ]);
});

Deno.test("copy-no-dashes - the held mass-delete review", () => {
  assertNoDashes("mass-delete review", [
    holdSentence(1850),
    holdNoticeText(1850, false),
    holdNoticeText(1, true),
    filesMissing(1),
    mainAction(1850, 0).label,
    mainAction(1850, 1850).label,
    mainAction(1850, 1).label,
    massDeleteConfirmTitle(1850),
    massDeleteConfirmMessage(1850, 30),
    massDeleteConfirmMessage(0, 1),
    trashNote(30),
    trashNote(1),
    massDeleteFormatDay(new Date(2026, 9, 8, 12).getTime()),
  ]);
});
