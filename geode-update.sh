#!/bin/sh
# Geode host update job (#43). A root cron line or a systemd timer runs this every
# minute; it takes no arguments and reads nothing but its own directory. A request in
# Geode's data folder only means "update now". Install: docs/architecture/server.md §11.
#
# The data folder belongs to the container, so nothing here writes into it as root: the
# request is removed with rm, which does not follow links, and the one restore that has
# to write the database runs in a throwaway container as uid 1993 instead.
#
# State lives in ./update-status, mounted read-only into Geode at /update-status:
#   heartbeat     epoch seconds of the last run, so a client can tell the job is installed
#   result        "<status> <epoch>", one of updated, up-to-date, rate-limited,
#                 pull-failed, rolled-back, rollback-failed
#   last-update   epoch seconds of the last attempt, the rate limit
#   failed-image  id of the image that failed here last: it is never started again
#   started       touched before a start, so a migration can be dated (see the rollback)
set -u
umask 022
# Cron's own PATH does not reach /usr/local/bin, where docker usually is.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# The compose directory is this script's own: no input decides it.
cd "$(dirname "$0")" || exit 1

DATA=data
REQUEST=$DATA/update-request
STATE=update-status
WAIT=120 # seconds a fresh image gets to report healthy
GAP=600  # at most one real update per ten minutes

result() { printf '%s %s\n' "$1" "$(date +%s)" > "$STATE/result"; }

mkdir -p "$STATE" || exit 1
date +%s > "$STATE/heartbeat"
[ -e "$REQUEST" ] || [ -L "$REQUEST" ] || exit 0

# One run at a time: an update outlasts the one-minute schedule. flock is released when
# its owner dies; where flock is missing the lock is a directory whose pid says whether
# the run is alive, so a run killed mid-update cannot wedge the job.
if command -v flock >/dev/null 2>&1; then
  exec 9>>"$STATE/lock" || exit 1
  flock -n 9 || exit 0
else
  if ! mkdir "$STATE/lock.d" 2>/dev/null; then
    kill -0 "$(cat "$STATE/lock.d/pid" 2>/dev/null)" 2>/dev/null && exit 0
    rm -rf -- "$STATE/lock.d"
    mkdir "$STATE/lock.d" 2>/dev/null || exit 0
  fi
  printf '%s\n' $$ > "$STATE/lock.d/pid"
  trap 'rm -rf -- "$STATE/lock.d"' EXIT
fi

# The container controls this path: rm removes the entry itself, never what it names.
rm -rf -- "$REQUEST"

now=$(date +%s)
last=$(cat "$STATE/last-update" 2>/dev/null)
# A torn or hand-edited value must not take the job down with an arithmetic error.
case $last in '' | *[!0-9]*) last=0 ;; esac
if [ "$((now - last))" -lt "$GAP" ]; then
  result rate-limited
  exit 0
fi
printf '%s\n' "$now" > "$STATE/last-update"

# The image a rollback goes back to is the one the container runs.
ref=$(docker compose config --images geode) || { result pull-failed; exit 1; }
cid=$(docker compose ps -q geode)
old=$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null) ||
  old=$(docker image inspect --format '{{.Id}}' "$ref") || { result pull-failed; exit 1; }

if ! docker compose pull --quiet geode ||
  ! new=$(docker image inspect --format '{{.Id}}' "$ref"); then
  result pull-failed
  exit 1
fi
[ "$new" != "$old" ] || { result up-to-date; exit 0; }
if [ "$new" = "$(cat "$STATE/failed-image" 2>/dev/null)" ]; then
  # This image already failed here. A newer one clears the block by not matching it.
  docker tag "$old" "$ref"
  result rolled-back
  exit 0
fi

: > "$STATE/started"
if docker compose up -d --wait --wait-timeout "$WAIT" geode >/dev/null 2>&1; then
  result updated
  exit 0
fi

# Put the running image back, and stop the failed container first: it is restarting, and
# nothing may write the database while the restore runs.
docker compose stop geode >/dev/null 2>&1
printf '%s\n' "$new" > "$STATE/failed-image"
docker tag "$old" "$ref" || { result rollback-failed; exit 1; }

# If the failed image ran a migration, the copy #45 took is newer than this run's start,
# and the old image may not read the migrated schema: restore the copy first. That runs
# in a throwaway container as uid 1993 with only the data folder mounted, because a root
# cp would follow a link the failed image left in that folder and overwrite a host file.
if [ -n "$(find "$DATA" -maxdepth 1 -name before-migration.sqlite -newer "$STATE/started")" ]; then
  docker run --rm --user 1993:1993 --network none --cap-drop ALL \
    -v "$PWD/$DATA:/data" --entrypoint sh "$old" -c \
    'rm -f /data/geode.db /data/geode.db-wal /data/geode.db-shm &&
     cp /data/before-migration.sqlite /data/geode.db' || { result rollback-failed; exit 1; }
fi
if docker compose up -d --wait --wait-timeout "$WAIT" --pull never geode >/dev/null 2>&1; then
  result rolled-back
else
  result rollback-failed
  exit 1
fi
