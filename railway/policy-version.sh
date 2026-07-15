#!/usr/bin/env bash

# The gateway and optimizer first understand the coordinated persistent-
# transcript policy in this release. Keep this threshold independent from the
# mutable image pins: release automation updates those pins, and the Railway
# paths become active only after both have crossed this boundary.
readonly ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_MIN_TAG="v1.10.117"

anyray_valid_release_tag() {
  [[ "${1:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

anyray_version_at_least() {
  local version="${1:-}" minimum="${2:-}"
  local version_major version_minor version_patch
  local minimum_major minimum_minor minimum_patch

  anyray_valid_release_tag "$version" || return 2
  anyray_valid_release_tag "$minimum" || return 2

  IFS=. read -r version_major version_minor version_patch <<< "${version#v}"
  IFS=. read -r minimum_major minimum_minor minimum_patch <<< "${minimum#v}"

  (( 10#$version_major > 10#$minimum_major )) && return 0
  (( 10#$version_major < 10#$minimum_major )) && return 1
  (( 10#$version_minor > 10#$minimum_minor )) && return 0
  (( 10#$version_minor < 10#$minimum_minor )) && return 1
  (( 10#$version_patch >= 10#$minimum_patch ))
}

anyray_policy_enabled_for_tag() {
  anyray_version_at_least "${1:-}" "$ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_MIN_TAG"
}

anyray_tag_from_image() {
  sed -nE 's#.*:(v[0-9]+\.[0-9]+\.[0-9]+)$#\1#p' <<< "${1:-}"
}
