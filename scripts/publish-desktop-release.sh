#!/usr/bin/env bash

# Publish signed desktop assets for a channel (stable by default), then rebuild the signed
# manifest and the channel feed from EVERY asset the versioned release holds.
# Each OS publishes through here as its chain finishes, so a failed OS leaves the
# others live and the final reconcile (--require-all) names what is missing.
#
# usage: publish-desktop-release.sh [--require-all] [signed-dir...]
# env:   REPO VERSION SOURCE_SHA TAG FEED ARTIFACT GH_TOKEN MIN_VERSION(optional) CHANNEL(optional)
#        DRY_RUN=true builds the consolidated assets/ (checksums, signed manifest) from the given
#        dirs and makes no GitHub release or feed call.
#        LINUX_SIGNING_GPG_KEY LINUX_SIGNING_GPG_PASSPHRASE
# Run from the repository root (it calls scripts/ siblings).

set -euo pipefail

require_all=0
if [ "${1:-}" = "--require-all" ]; then
  require_all=1
  shift
fi
for name in REPO VERSION SOURCE_SHA TAG FEED ARTIFACT GH_TOKEN; do
  [ -n "${!name:-}" ] || { echo "::error::$name is required"; exit 2; }
done
MIN_VERSION="${MIN_VERSION:-}"
CHANNEL="${CHANNEL:-stable}"
dry_run="${DRY_RUN:-false}"
channel_flags=()
if [ "$CHANNEL" != stable ]; then
  channel_flags=(--prerelease)
fi

retry() {
  local attempt=1
  until "$@"; do
    if [ "$attempt" -ge 3 ]; then
      return 1
    fi
    echo "::warning::attempt ${attempt} of '$1 $2' failed; retrying"
    attempt=$((attempt + 1))
    sleep 15
  done
}

if [ "$dry_run" != true ]; then
  latest_before="$(gh api "repos/${REPO}/releases/latest" --jq .tag_name)"

  if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    if [ "$#" -eq 0 ]; then
      echo "::error::desktop release ${TAG} was never created; no OS published"
      exit 1
    fi
    # --latest=false: releases/latest belongs to the CLI (connect.sh and the self-updater read it).
    gh release create "$TAG" --repo "$REPO" \
      --title "Anyray Connect desktop ${VERSION}" \
      --notes "Signed desktop installers and update manifest built from private monorepo commit ${SOURCE_SHA}. Download from the connect-desktop release for a stable link per OS." \
      --latest=false ${channel_flags[@]+"${channel_flags[@]}"}
  fi

  # Published assets are immutable: clients already hold their checksums. A file is uploaded only when
  # absent, skipped when the release already has the same bytes, and refused when it differs. An asset
  # a failed attempt left half-uploaded (any state but "uploaded") is deleted and sent again. Uploads
  # stay apart from release creation so a stalled asset retries without deleting the release (#515).
  release_id="$(gh api "repos/${REPO}/releases/tags/${TAG}" --jq .id)"

  publish_asset() {
    local file="$1" name local_sha row id state digest remote_sha
    name="$(basename "$file")"
    local_sha="$(sha256sum "$file" | cut -d' ' -f1)"
    row="$(gh api --paginate "repos/${REPO}/releases/${release_id}/assets?per_page=100" \
      --jq '.[] | [.id, .name, .state, (.digest // "")] | @tsv' | awk -F'\t' -v n="$name" '$2 == n')"
    if [ -n "$row" ]; then
      IFS=$'\t' read -r id _ state digest <<< "$row"
      if [ "$state" = uploaded ]; then
        if [ -n "$digest" ]; then
          remote_sha="${digest#sha256:}"
        else
          rm -rf published-check
          gh release download "$TAG" --repo "$REPO" --pattern "$name" --dir published-check
          remote_sha="$(sha256sum "published-check/${name}" | cut -d' ' -f1)"
        fi
        if [ "$remote_sha" = "$local_sha" ]; then
          echo "${name} is already published with these bytes; skipping"
          return 0
        fi
        echo "::error::${name} is already published on ${TAG} with different bytes; published assets are never replaced. Cut a new version instead."
        exit 1
      fi
      gh api -X DELETE "repos/${REPO}/releases/assets/${id}"
    fi
    gh release upload "$TAG" --repo "$REPO" "$file"
  }

  for dir in "$@"; do
    for file in "$dir"/*; do
      retry publish_asset "$file"
    done
  done
fi

rm -rf assets keycheck
mkdir assets keycheck
if [ "$dry_run" = true ]; then
  for dir in "$@"; do
    cp "$dir"/* assets/
  done
else
  retry gh release download "$TAG" --repo "$REPO" --dir assets --clobber
fi
rm -f assets/SHA256SUMS assets/SHA256SUMS.asc "assets/${FEED}.json" "assets/${FEED}.json.asc"

present=()
missing=()
check_os() {
  local os="$1" pattern
  shift
  for pattern in "$@"; do
    if ! compgen -G "assets/${pattern}" >/dev/null; then
      missing+=("$os")
      return
    fi
  done
  present+=("$os")
}
check_os macos '*-macos-universal.pkg' '*.app.tar.gz'
check_os windows '*-windows-x64.msi'
check_os linux '*-linux-x64.deb' '*-linux-x64.rpm'
echo "desktop OSes on ${TAG}: present=[${present[*]:-}] missing=[${missing[*]:-}]"

# A throwaway signature exports the public key, so the set carries it even before Linux publishes.
printf 'public key export' > keycheck/probe
./scripts/sign-gpg-artifacts.sh keycheck keycheck/probe
cp keycheck/anyray-endpoint-signing-key.asc assets/anyray-connect-desktop-signing-key.asc

( cd assets && sha256sum -- * > SHA256SUMS )

# minVersion forces every install onto this release, so it is only safe once no OS lacks an artifact.
min=""
if [ "${#missing[@]}" -eq 0 ]; then
  min="$MIN_VERSION"
fi
manifest="assets/${FEED}.json"
jq -Rn \
  --arg version "$VERSION" \
  --arg sourceCommit "$SOURCE_SHA" \
  --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg tag "$TAG" \
  --arg artifact "$ARTIFACT" \
  --arg feed "${FEED}.json" \
  --arg min "$min" \
  '[inputs | capture("^(?<sha256>[0-9a-f]{64})  (?<name>.+)$")] as $artifacts
   | {schemaVersion: 1, artifact: $artifact, version: $version, sourceCommit: $sourceCommit, createdAt: $createdAt, tag: $tag}
   + (if $min == "" then {} else {minVersion: $min} end)
   + {updater: {feed: $feed}, artifacts: $artifacts}' \
  assets/SHA256SUMS > "$manifest"

./scripts/sign-gpg-artifacts.sh keycheck assets/SHA256SUMS "$manifest"
cmp keycheck/anyray-endpoint-signing-key.asc assets/anyray-connect-desktop-signing-key.asc
verify_home="$(mktemp -d "${RUNNER_TEMP:-/tmp}/gv.XXXXXX")"
chmod 700 "$verify_home"
GNUPGHOME="$verify_home" gpg --batch --import assets/anyray-connect-desktop-signing-key.asc
GNUPGHOME="$verify_home" gpg --batch --verify assets/SHA256SUMS.asc assets/SHA256SUMS
GNUPGHOME="$verify_home" gpg --batch --verify "${manifest}.asc" "$manifest"
rm -rf "$verify_home"

test "$(jq -r .version "$manifest")" = "$VERSION"
test "$(jq -r .sourceCommit "$manifest")" = "$SOURCE_SHA"
test "$(jq -r .artifact "$manifest")" = "$ARTIFACT"
test "$(jq -r .tag "$manifest")" = "$TAG"
jq -e --arg feed "${FEED}.json" '.updater.feed == $feed' "$manifest" >/dev/null
for os in "${present[@]}"; do
  case "$os" in
    macos) suffix='-macos-universal.pkg' ;;
    windows) suffix='-windows-x64.msi' ;;
    linux) suffix='-linux-x64.deb' ;;
  esac
  jq -e --arg suffix "$suffix" '[.artifacts[] | select(.name | endswith($suffix))] | length == 1' "$manifest" >/dev/null
done
if [ "${#missing[@]}" -gt 0 ]; then
  jq -e 'has("minVersion") | not' "$manifest" >/dev/null
fi

if [ "$dry_run" = true ]; then
  echo "dry run: consolidated checksums and signed manifest are in assets/; no release or feed was touched"
else
  # Only the derived files are replaced: they describe whatever is on the release right now.
  retry gh release upload "$TAG" --repo "$REPO" --clobber \
    assets/SHA256SUMS assets/SHA256SUMS.asc "$manifest" "${manifest}.asc" \
    assets/anyray-connect-desktop-signing-key.asc

  CHANNEL="$CHANNEL" node scripts/publish-desktop-feed.mjs
  test "$(gh api "repos/${REPO}/releases/latest" --jq .tag_name)" = "$latest_before" || {
    echo "::error::desktop release changed releases/latest"
    exit 1
  }
  retry bash -c "curl -fsSL 'https://github.com/${REPO}/releases/download/${FEED}/${FEED}.json' | jq -e --arg v '${VERSION}' '.version == \$v' >/dev/null"
fi

if [ "$require_all" -eq 1 ] && [ "${#missing[@]}" -gt 0 ]; then
  echo "::error::desktop release ${VERSION} is missing: ${missing[*]}. The CLI and the other OSes are published; a rebuild re-signs to new bytes, so release a new version."
  exit 1
fi
