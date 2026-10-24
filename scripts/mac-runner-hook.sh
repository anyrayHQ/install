#!/usr/bin/env bash
# Runner job hooks for the persistent macOS signing host (RELEASING.md, "The persistent
# macOS signing host"). Installed root-owned on the host and run through four symlinks,
# sign-job-started.sh, sign-job-completed.sh, build-job-started.sh and build-job-completed.sh,
# that each role's runner .env names in
# ACTIONS_RUNNER_HOOK_JOB_STARTED / ACTIONS_RUNNER_HOOK_JOB_COMPLETED. job-started runs before
# the first step and fails the job when it exits non-zero: it refuses anything but a main
# dispatch of a release workflow by a maintainer (this repo is public, so a fork pull request
# can name the label in its own workflow), checks the job and non-admin account for its
# role, then checks the disk floor, resets the keychain
# search list and sets the previous workspace aside. job-completed repeats the cleanup and
# never fails the job.

# Release maintainers' GitHub account ids. Must equal MAINTAINER_ACCOUNT_IDS in mac-fleet.sh
# (the fleet webhook's actor filter); the test holds the two lists together.
MAINTAINER_ACCOUNT_IDS="16443050 187185370"
# The person who re-runs a job is GITHUB_TRIGGERING_ACTOR; GITHUB_ACTOR_ID stays the
# original dispatcher. A renamed login fails closed (only someone with write access can re-run).
MAINTAINER_LOGINS="0xtechdean Dima-Othentic"
SIGN_ACCOUNT=anyray-sign
BUILD_ACCOUNT=anyray-build
SIGN_JOBS="sign-macos"
BUILD_JOBS="build-macos-unsigned verify-macos-signed verify-macos-launch"
REPOSITORY="anyrayHQ/install"
# The only workflows that may run on this host, at main. A called workflow reports its caller's
# ref here, and both are dispatchable on their own, so both are listed.
ALLOWED_WORKFLOWS="anyrayHQ/install/.github/workflows/release-connect-binaries.yml@refs/heads/main
anyrayHQ/install/.github/workflows/release-connect-desktop.yml@refs/heads/main"
FREE_GB_FLOOR=20

set -uo pipefail

if [ "$#" -eq 2 ]; then
  role="$1"
  phase="$2"
elif [ "$#" -eq 0 ]; then
  name="${0##*/}"
  name="${name%.sh}"
  role="${name%%-*}"
  phase="${name#*-}"
else
  echo 'Usage: mac-runner-hook.sh sign|build job-started|job-completed' >&2
  exit 2
fi
case "$role-$phase" in
  sign-job-started|sign-job-completed|build-job-started|build-job-completed) ;;
  *) echo 'Usage: mac-runner-hook.sh sign|build job-started|job-completed' >&2; exit 2 ;;
esac

problem() {
  if [ "$phase" = job-started ]; then
    printf '::error::%s\n' "$1" >&2
  else
    printf '::warning::%s\n' "$1" >&2
  fi
}

trust_gate() {
  local workflow actor allowed
  if [ "${GITHUB_REPOSITORY:-}" != "$REPOSITORY" ]; then
    problem 'GITHUB_REPOSITORY check failed'
    return 1
  fi
  if [ "${GITHUB_EVENT_NAME:-}" != workflow_dispatch ]; then
    problem 'GITHUB_EVENT_NAME check failed'
    return 1
  fi
  if [ "${GITHUB_REF:-}" != refs/heads/main ]; then
    problem 'GITHUB_REF check failed'
    return 1
  fi
  allowed=0
  while IFS= read -r workflow; do
    if [ "${GITHUB_WORKFLOW_REF:-}" = "$workflow" ]; then
      allowed=1
      break
    fi
  done <<< "$ALLOWED_WORKFLOWS"
  if [ "$allowed" -ne 1 ]; then
    problem 'GITHUB_WORKFLOW_REF check failed'
    return 1
  fi
  allowed=0
  for actor in $MAINTAINER_ACCOUNT_IDS; do
    if [ "${GITHUB_ACTOR_ID:-}" = "$actor" ]; then
      allowed=1
      break
    fi
  done
  if [ "$allowed" -ne 1 ]; then
    problem 'GITHUB_ACTOR_ID check failed'
    return 1
  fi
  allowed=0
  for actor in $MAINTAINER_LOGINS; do
    if [ "${GITHUB_TRIGGERING_ACTOR:-}" = "$actor" ]; then
      allowed=1
      break
    fi
  done
  if [ "$allowed" -ne 1 ]; then
    problem 'GITHUB_TRIGGERING_ACTOR check failed'
    return 1
  fi
}

job_gate() {
  local jobs job
  # Explicit per role: an unknown role must never inherit the build role's jobs.
  case "$role" in
    sign) jobs="$SIGN_JOBS" ;;
    build) jobs="$BUILD_JOBS" ;;
    *) problem 'Hook role check failed'; return 1 ;;
  esac
  for job in $jobs; do
    [ "${GITHUB_JOB:-}" = "$job" ] && return 0
  done
  problem 'GITHUB_JOB check failed'
  return 1
}

account_gate() {
  local account user groups group
  case "$role" in
    sign) account="$SIGN_ACCOUNT" ;;
    build) account="$BUILD_ACCOUNT" ;;
    *) problem 'Hook role check failed'; return 1 ;;
  esac
  user="$(id -un)" || { problem 'Runner account check failed'; return 1; }
  if [ "$user" != "$account" ]; then
    problem 'Runner account check failed'
    return 1
  fi
  groups="$(id -Gn)" || { problem 'Runner admin-group check failed'; return 1; }
  for group in $groups; do
    if [ "$group" = admin ]; then
      problem 'Runner admin-group check failed'
      return 1
    fi
  done
  if sudo -n true >/dev/null 2>&1; then
    problem 'Runner sudo check failed'
    return 1
  fi
}

validate_home_and_temp() {
  case "${HOME:-}" in
    /*) ;;
    *) problem 'HOME path check failed'; return 1 ;;
  esac
  case "${RUNNER_TEMP:-}" in
    /*/_temp) ;;
    *) problem 'RUNNER_TEMP path check failed'; return 1 ;;
  esac
}

validate_paths() {
  local work_root
  validate_home_and_temp || return 1
  work_root="${RUNNER_TEMP%/_temp}"
  case "${GITHUB_WORKSPACE:-}" in
    "$work_root/"?*) ;;
    *) problem 'GITHUB_WORKSPACE work-root check failed'; return 1 ;;
  esac
  case "/$GITHUB_WORKSPACE/" in
    */../*) problem 'GITHUB_WORKSPACE parent-component check failed'; return 1 ;;
  esac
}

free_gb() {
  df -Pk "$HOME" 2>/dev/null | awk '
    NR == 2 && $4 ~ /^[0-9]+$/ { print int($4 / 1048576); found = 1 }
    END { if (!found) exit 1 }
  '
}

check_disk() {
  local free trash old summary old_count oldest_minutes
  trash="$HOME/.runner-trash"
  free="$(free_gb)" || { problem 'Disk free-space check failed'; return 1; }
  if [ -d "$trash" ]; then
    if stat -f '%m' "$trash" >/dev/null 2>&1; then
      old="$(find "$trash" -mindepth 1 -maxdepth 1 -type d -mmin +60 -exec stat -f '%m' {} + 2>/dev/null)" \
        || { problem 'Runner trash age check failed'; return 1; }
    else
      old="$(find "$trash" -mindepth 1 -maxdepth 1 -type d -mmin +60 -exec stat -c '%Y' {} + 2>/dev/null)" \
        || { problem 'Runner trash age check failed'; return 1; }
    fi
    if [ -n "$old" ]; then
      summary="$(printf '%s\n' "$old" | awk -v now="$(date +%s)" '
        /^[0-9]+$/ { count++; if (count == 1 || $1 < oldest) oldest = $1 }
        END { if (!count) exit 1; printf "%d %d\n", count, int((now - oldest) / 60) }
      ')" || { problem 'Runner trash age check failed'; return 1; }
      read -r old_count oldest_minutes <<< "$summary"
      printf '::warning::Runner trash has %s directories older than 60 minutes; oldest is %s minutes old; details are in cleanup.log on the host\n' "$old_count" "$oldest_minutes"
    fi
  fi
  if [ "$free" -lt "$FREE_GB_FLOOR" ]; then
    if [ -d "$trash" ]; then
      find "$trash" -mindepth 1 -maxdepth 1 -type d -mmin +60 -exec rm -rf {} + 2>>"$trash/cleanup.log" \
        || echo '::warning::Old runner trash cleanup failed; check cleanup.log on the host' >&2
    fi
    free="$(free_gb)" || { problem 'Disk free-space recheck failed'; return 1; }
    if [ "$free" -lt "$FREE_GB_FLOOR" ]; then
      problem "Disk floor check failed: less than $FREE_GB_FLOOR GB free; see cleanup.log on the host and RELEASING.md, The persistent macOS signing host (ANY-1405)"
      return 1
    fi
  fi
}

reset_keychains() {
  local keychain login failed=0
  command -v security >/dev/null 2>&1 || return 0
  validate_home_and_temp || return 1
  # Every signing job sets default-keychain and list-keychains to a throwaway
  # keychain in RUNNER_TEMP. These user preferences outlive a job on a persistent
  # host, leaving a deleted keychain as the next job's default unless we reset them.
  for keychain in "$RUNNER_TEMP"/*.keychain-db; do
    [ -f "$keychain" ] || continue
    security delete-keychain "$keychain" >/dev/null 2>&1 || true
    rm -f "$keychain" 2>/dev/null || { problem 'Throwaway keychain removal failed'; failed=1; }
  done
  login="$HOME/Library/Keychains/login.keychain-db"
  if [ -f "$login" ]; then
    security list-keychains -d user -s "$login" >/dev/null 2>&1 \
      || { problem 'Keychain search-list reset failed'; failed=1; }
    security default-keychain -d user -s "$login" >/dev/null 2>&1 \
      || { problem 'Default keychain reset failed'; failed=1; }
  else
    security list-keychains -d user -s >/dev/null 2>&1 \
      || { problem 'Keychain search-list reset failed'; failed=1; }
  fi
  return "$failed"
}

set_workspace_aside() {
  local trash mine entry failed=0
  [ -e "$GITHUB_WORKSPACE" ] || return 0
  trash="$HOME/.runner-trash"
  mine="$trash/$(date +%s)-$$"
  mkdir -p "$mine" 2>/dev/null || { problem 'Workspace trash creation failed'; return 1; }
  for entry in "$GITHUB_WORKSPACE"/* "$GITHUB_WORKSPACE"/.[!.]* "$GITHUB_WORKSPACE"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    [ "${entry##*/}" = .git ] && continue
    mv "$entry" "$mine/" 2>/dev/null || { problem 'Workspace entry move failed'; failed=1; }
  done
  if command -v taskpolicy >/dev/null 2>&1; then
    set -- taskpolicy -b
  else
    set -- nice -n 19
  fi
  # Empty tracking id detaches the low-priority delete from the runner's orphan
  # sweep. The next started hook also covers a crash before the completed hook.
  # shellcheck disable=SC2016 # $1 and $2 expand in the child sh, by design
  RUNNER_TRACKING_ID="" nohup "$@" sh -c 'rm -rf "$1" 2>>"$2/cleanup.log"; find "$2" -mindepth 1 -maxdepth 1 -type d -mmin +60 -exec rm -rf {} + 2>>"$2/cleanup.log"' sh "$mine" "$trash" >/dev/null 2>&1 &
  return "$failed"
}

if [ "$phase" = job-started ]; then
  trust_gate || exit 1
  job_gate || exit 1
  account_gate || exit 1
  validate_paths || exit 1
  check_disk || exit 1
  reset_keychains || exit 1
  set_workspace_aside || exit 1
  if ! { : > "$RUNNER_TEMP/.trust-gate-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB"; } 2>/dev/null; then
    problem 'Trust-gate canary write check failed'
    exit 1
  fi
  printf '::notice::trust gate passed (%s %s)\n' "$role" "$phase"
else
  reset_keychains || true
  if validate_paths; then
    set_workspace_aside || true
  fi
fi
exit 0
