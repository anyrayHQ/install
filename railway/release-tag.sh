#!/usr/bin/env bash

# Shared release-tag helpers for the Railway install scripts.

anyray_valid_release_tag() {
  [[ "${1:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

anyray_tag_from_image() {
  sed -nE 's#.*:(v[0-9]+\.[0-9]+\.[0-9]+)$#\1#p' <<< "${1:-}"
}
