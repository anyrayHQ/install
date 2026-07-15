#!/usr/bin/env bash

# Railway install semantics are owned by the install artifact, not by the
# nightly-stamped product version. The marker is shared with setup/release CI;
# older repository revisions without it retain their legacy behavior.
readonly ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_CAPABILITY="persistentTranscriptPolicyV1"

anyray_valid_release_tag() {
  [[ "${1:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

anyray_tag_from_image() {
  sed -nE 's#.*:(v[0-9]+\.[0-9]+\.[0-9]+)$#\1#p' <<< "${1:-}"
}

anyray_install_has_capability() {
  local install_root="${1:-}"
  if [ -z "$install_root" ]; then
    install_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  fi
  [ -s "$install_root/compatibility/$ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_CAPABILITY" ]
}
