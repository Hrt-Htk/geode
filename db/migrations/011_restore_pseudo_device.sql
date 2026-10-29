-- Flag the per-vault trash-restore pseudo-device so it is never confused with a
-- real device that happens to share its name (device rename, #330).
ALTER TABLE devices ADD COLUMN is_restore INTEGER DEFAULT 0;
