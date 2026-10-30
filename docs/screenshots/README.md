---
covers: []
---

# Screenshots

Every image here was taken in real Obsidian, on the desktop and on an Android phone, from a demo
vault of invented notes (`test/e2e/fixtures/demo-vault`): no personal note, name or place appears in
any of them. They use Obsidian's own default theme in dark mode, at a fixed window size, and the two
device names the demo vault syncs between, Laptop and Phone.

`deno task docs:screenshots` reshoots all of them in one run (desktop and the connected phone) and
stamps the plugin version into every caption, so the version a picture was taken on is never out of
date. Images whose version differs from the current plugin were taken before the latest changes.

## Sync

![The conflict review window: two versions of the same note side by side, each in its own colour, with Keep original, Keep conflict and Keep both buttons](conflict-review.png)

*The conflict review window. Both devices changed the same line, so Geode kept both versions and
asks which one to keep. Taken on plugin v0.41.7.*

![The Conflicts window listing one note with a conflict, with Review and Open both](conflicts-list.png)

*Conflicts waiting for a decision, from the status icon's menu. Taken on plugin v0.41.7.*

## Recovery

![The file history window: a list of editing periods on the left, and the selected version diffed against the current one on the right](history-restore.png)

*File history. Each period is one device's run of saves; the selected version is diffed against the
note as it is now, and Restore this version brings it back. Taken on plugin v0.41.7.*

![The file history window on the phone, showing the selected version's preview with a Back button above it](file-history-phone.png)

*The same history on the phone, where the period list and the preview stack instead of sitting side by
side. Taken on plugin v0.41.7.*

![The Deleted files window with two deleted notes, each with History, View, Restore and Purge](deleted-files.png)

*Deleted files stay restorable for 30 days before Geode purges them. Taken on plugin v0.41.7.*

![The review window for a mass delete: 21 files missing of 31 tracked, a folder tree with per-folder toggles, and a Restore 21 files button](mass-delete-review.png)

*When many files disappear at once, sync holds instead of deleting them everywhere. You review what
went missing, then restore it or confirm the delete. Taken on plugin v0.41.7.*

## Seeing what is happening

![The phone's status icon menu open over a note, listing Pause, Sync activity, Conflicts, Deleted files, Devices and Geode settings](status-menu-phone.png)

*The status icon on the phone, with its menu: pause, sync activity, conflicts, deleted files, devices
and settings. Taken on plugin v0.41.7.*

![The sync activity window listing files that were deleted or uploaded, with their device and time](sync-activity.png)

*Sync activity: one row per file, the newest first, with the device that changed it. Taken on plugin v0.41.7.*

![The Geode settings tab, showing the Status and Vault sections over Obsidian's settings sidebar](settings.png)

*The settings tab: status, server storage, and the vault rows. Taken on plugin v0.41.7.*

![The Devices window listing Laptop, up to date, and Phone, never synced, with Rename and Revoke buttons](devices.png)

*The devices on the vault, with revoke for a lost or stolen one. Taken on plugin v0.41.7.*

## Security and setup

![The setup wizard's create step, with a server address field filled in and an admin token field](setup-wizard.png)

*The setup wizard: one server and admin token per vault, then a passphrase. Taken on plugin v0.41.7.*

![The change passphrase window with current, new and confirm fields](change-passphrase.png)

*A new passphrase re-encrypts the vault. Geode estimates the run first and resumes it if it is
interrupted. Taken on plugin v0.41.7.*

## Selective sync

![The Sync folders window with the demo vault's folders, the 99 - System folder switched off](sync-folders.png)

*Folders left out of sync stay on the device that has them. Taken on plugin v0.41.7.*

![The Config to sync window with switches for five settings categories and for two community plugins](config-to-sync.png)

*Which Obsidian settings and community plugins follow the vault. Taken on plugin v0.41.7.*

## How they are made

The `docs` Playwright project drives the screens above through the real plugin and writes the PNGs
straight into this folder (`test/e2e/scenarios/docs-shots.spec.ts` on the desktop,
`docs-shots-phone.spec.ts` on the phone). It is not part of the normal end-to-end runs:

```bash
deno task docs:screenshots
```
