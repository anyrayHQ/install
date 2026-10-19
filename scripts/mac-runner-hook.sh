#!/usr/bin/env bash
# Runner job hooks for the persistent macOS signing host (RELEASING.md, "The persistent
# macOS signing host"). Installed root-owned on the host and run through two symlinks,
# job-started.sh and job-completed.sh, that the runner's .env names in
# ACTIONS_RUNNER_HOOK_JOB_STARTED / ACTIONS_RUNNER_HOOK_JOB_COMPLETED. job-started runs before
# the first step and fails the job when it exits non-zero: it refuses anything but a main
# dispatch of a release workflow by a maintainer (this repo is public, so a fork pull request
# can name the label in its own workflow), then checks the disk floor, resets the keychain
# search list and sets the previous workspace aside. job-completed repeats the cleanup and
# never fails the job.

# Release maintainers' GitHub account ids. Must equal MAINTAINER_ACCOUNT_IDS in mac-fleet.sh
# (the fleet webhook's actor filter); the test holds the two lists together.
MAINTAINER_ACCOUNT_IDS="16443050 187185370"
REPOSITORY="anyrayHQ/install"
# The only workflows that may run on this host, at main. A called workflow reports its caller's
# ref here, and all three are dispatchable on their own, so all three are listed.
ALLOWED_WORKFLOWS="anyrayHQ/install/.github/workflows/release-connect-binaries.yml@refs/heads/main
anyrayHQ/install/.github/workflows/release-connect-desktop.yml@refs/heads/main
anyrayHQ/install/.github/workflows/release-fleetd-installer.yml@refs/heads/main"
FREE_GB_FLOOR=20

set -uo pipefail

if [ "$#" -gt 0 ]; then
  phase="$1"
else
  phase="${0##*/}"
  phase="${phase%.sh}"
fi
case "$phase" in
  job-started|job-completed) ;;
  *) echo 'Usage: mac-runner-hook.sh job-started|job-completed' >&2; exit 2 ;;
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
  local free trash old
  trash="$HOME/.runner-trash"
  free="$(free_gb)" || { problem 'Disk free-space check failed'; return 1; }
  if [ -d "$trash" ]; then
    old="$(find "$trash" -mindepth 1 -maxdepth 1 -type d -mmin +60 -print -quit 2>/dev/null)" \
      || { problem 'Runner trash age check failed'; return 1; }
    if [ -n "$old" ]; then
      echo "::warning::Runner trash directories are older than 60 minutes; check $trash/cleanup.log"
      if [ -f "$trash/cleanup.log" ]; then
        tail -n 5 "$trash/cleanup.log" || true
      fi
    fi
  fi
  if [ "$free" -lt "$FREE_GB_FLOOR" ]; then
    if [ -d "$trash" ]; then
      find "$trash" -mindepth 1 -maxdepth 1 -type d -mmin +60 -exec rm -rf {} + 2>>"$trash/cleanup.log" \
        || echo "::warning::Old runner trash cleanup failed; check $trash/cleanup.log" >&2
    fi
    free="$(free_gb)" || { problem 'Disk free-space recheck failed'; return 1; }
    if [ "$free" -lt "$FREE_GB_FLOOR" ]; then
      problem "Disk floor check failed: less than $FREE_GB_FLOOR GB free; see $trash/cleanup.log and RELEASING.md, The persistent macOS signing host (ANY-1405)"
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
  validate_paths || exit 1
  check_disk || exit 1
  reset_keychains || exit 1
  set_workspace_aside || exit 1
else
  reset_keychains || true
  if validate_paths; then
    set_workspace_aside || true
  fi
fi
exit 0
