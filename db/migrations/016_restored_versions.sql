-- #687: a restore is credited to the real device that asked for it, so the row
-- carries a mark: the apply rule skips a device's own version unless it is restored.
-- A constant default keeps this ADD COLUMN O(1); every existing row is ordinary.
ALTER TABLE file_versions ADD COLUMN restored INTEGER NOT NULL DEFAULT 0;

-- The per-vault trash-restore pseudo device (#455) is retired. Migration 011 added
-- the flag but never set it, so the row prod already carries is still is_restore = 0.
-- Match on the empty plugin_version too: a pseudo device never handshakes, while a
-- real device a user renamed to the reserved name (#330) has reported its version.
UPDATE devices SET is_restore = 1
 WHERE name = 'geode-trash-restore'
   AND (plugin_version IS NULL OR plugin_version = '');

-- The versions that pseudo device authored are restores. Keeping the mark on them is
-- what lets history label them without the retired device's name.
UPDATE file_versions SET restored = 1
 WHERE device_id IN (SELECT id FROM devices WHERE is_restore = 1);
