-- #583: server-visible rename marker on a version row:
--   0 = ordinary version, 1 = marker (a rename's closing version of the old path),
--   2 = note (the new path's first version).
-- Markers and notes are never compacted and a marker is never a trash entry.
-- A constant default keeps this ADD COLUMN O(1).
ALTER TABLE file_versions ADD COLUMN rename_mark INTEGER NOT NULL DEFAULT 0;
