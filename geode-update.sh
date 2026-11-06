#!/bin/sh
# Geode host update job: answers the update request the plugin leaves in Geode's data
# folder, and undoes a release that does not come up. A root cron line or a systemd timer
# runs it every minute; it takes no arguments and reads nothing but its own directory.
# Install: docs/architecture/server.md §11.
set -u
umask 022
# Cron's own PATH does not reach /usr/local/bin, where docker usually is.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# The compose directory is this script's own: no input decides it.
cd "$(dirname "$0")" || exit 1

DATA=data
REQUEST=$DATA/update-request
STATE=update-status
LOCK=.update-lock # in the compose directory: /update-status is mounted into the container
WAIT=300   # seconds a fresh image gets to report healthy
GAP=600    # at most one real update per ten minutes
EXPIRY=86400 # a failed image is not retried for a day

refuse() { echo "geode-update: $*" >&2; exit 1; }
result() { printf '%s %s\n' "$1" "$(date +%s)" > "$STATE/result"; }
# Geode is down after this one: the plugin cannot show the status file, so cron mail and
# the journal get the reason too.
fail() { result rollback-failed; refuse "$*"; }

# docker compose without the lock fd: a child that outlives this script (a killed run
# leaves `up --wait` behind) must not keep the lock and block the next run.
compose() { docker compose "$@" 9>&-; }

# Root runs everything in this directory every minute (compose.yaml, any override, this
# script), so only root may be able to write it. One rule for the directory and every entry
# in it: find does not dereference, so a symlink is refused by its own 0777 mode, and the
# data folder is the container's, by name.
[ "$(id -u)" = 0 ] || refuse "must run as root"
mkdir -p "$STATE" || exit 1
bad=$(find . -maxdepth 1 ! -name data '(' ! -uid 0 -o -perm /022 ')' -print | tr '\n' ' ')
[ -z "$bad" ] || refuse "not root's, or writable by group or other: $bad"
command -v flock >/dev/null 2>&1 || { result no-flock; refuse "flock not found (util-linux)"; }

# The #45 copy of the database, restored in a throwaway container as uid 1993 with only the
# data folder mounted: a root cp would follow a link the failed image left in that folder.
restore() {
  docker run --rm --user 1993:1993 --network none --cap-drop ALL \
    -v "$PWD/$DATA:/data" --entrypoint sh "$1" -c \
    'rm -f /data/geode.db /data/geode.db-wal /data/geode.db-shm &&
     cp /data/before-migration.sqlite /data/geode.db' 9>&-
}

# Only db.ts writes that copy, only when a migration is pending, and it writes a regular
# file: a regular file newer than the start is a copy. find does not dereference, so a link
# or a FIFO the failed image left there is not one, and the restore that would follow it, or
# block on it forever, does not run.
migrated() {
  [ -n "$(find "$DATA" -maxdepth 1 -type f -name before-migration.sqlite -newer "$STATE/started" 2>/dev/null)" ]
}

# Put image $1 back, restoring the database if the failed start migrated it. The tag comes
# first: a marker whose image was pruned must not stop a running server before we know it
# cannot go back. The recover marker survives a failure here, so the next run tries again.
rollback() {
  docker tag "$1" "$ref" || fail "cannot put image $1 back on $ref"
  compose stop geode >/dev/null 2>&1
  migrated && ! restore "$1" && fail "the database restore failed"
  if compose up -d --wait --wait-timeout "$WAIT" --pull never geode >/dev/null 2>&1; then
    rm -f "$STATE/recover"
    result rolled-back
    exit 0
  fi
  fail "image $1 did not come up"
}

date +%s > "$STATE/heartbeat"

# Nothing to do without a request or a marker a killed run left behind. A marker is gated
# on being non-empty: a write that died half way must not stand in for a request. The lock
# is taken next, before the marker is read, or one run could roll back what another just
# finished and remove. It lives beside the compose file, not in /update-status: the
# container can see that folder, and flock takes a lock on a read-only file.
[ -s "$STATE/recover" ] || [ -e "$REQUEST" ] || [ -L "$REQUEST" ] || exit 0
exec 9>>"$LOCK" || exit 1
flock -n 9 || exit 0

# Finish the rollback a killed run did not: it fires once, for what this job itself did.
recover=$(cat "$STATE/recover" 2>/dev/null)
ref=$(compose config --images geode 2>/dev/null) || { result config-failed; exit 1; }
if [ -n "$recover" ]; then
  rollback "$recover"
fi

# The container controls this path: rm removes the entry itself, never what it names.
rm -rf -- "$REQUEST"
result running

now=$(date +%s)
last=$(cat "$STATE/last-update" 2>/dev/null)
last=${last:-0}
if [ "$((now - last))" -lt "$GAP" ]; then
  result rate-limited
  exit 0
fi

cid=$(compose ps -q geode 2>/dev/null)
old=$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null) || { result config-failed; exit 1; }

if ! compose pull --quiet geode >/dev/null 2>&1 ||
  ! new=$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null); then
  result pull-failed
  exit 1
fi
[ "$new" != "$old" ] || { result up-to-date; exit 0; }

failed=$(cat "$STATE/failed-image" 2>/dev/null)
if [ "${failed% *}" = "$new" ] && [ "$((now - ${failed#* }))" -lt "$EXPIRY" ]; then
  result blocked
  exit 0
fi

printf '%s\n' "$now" > "$STATE/last-update"
: > "$STATE/started"
# The pull moved the running image's only tag, so a tag keeps the way back: a scheduled
# `docker image prune` would otherwise delete it once the old container is gone.
docker tag "$old" "${ref%:*}:before-update" || { result config-failed; exit 1; }
printf '%s\n' "$old" > "$STATE/recover"
if compose up -d --wait --wait-timeout "$WAIT" geode >/dev/null 2>&1; then
  rm -f "$STATE/recover"
  result updated
  exit 0
fi
printf '%s %s\n' "$new" "$(date +%s)" > "$STATE/failed-image"
rollback "$old"
