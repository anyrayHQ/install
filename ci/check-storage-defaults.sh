#!/usr/bin/env bash
#
# Assert every install artifact provisions the datastore size declared in
# ci/storage-defaults.env.
#
# Why this gate exists: the gateway keeps 90 days of trace content by default,
# so every datastore has to survive three months of accumulation before the
# first prune reclaims anything. A volume that fills stops Postgres and takes
# the spend + trace stores with it. The size therefore has to be right in FIVE
# artifacts written in five languages, and a hand-copied constant drifts the
# moment one of them is edited alone. Same failure class, and the same fix, as
# ci/critical-gateway-env.txt + ci/check-service-env-coverage.sh.
#
# Reads the sizes from one file so the number lives in exactly one place, then
# checks both directions:
#   - every artifact that provisions storage carries the shared value
#   - the Helm CHART default has NOT been raised (see the carve-out below)
#
# No cluster or cloud credentials needed: every check reads a source file.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=ci/storage-defaults.env
. ci/storage-defaults.env

fail=0

# check <description> <expected> <file> <grep-pattern>
#
# Greps the artifact for the pattern and asserts the matched line contains the
# expected value. Deliberately matches the line rather than parsing each format
# (YAML/JSON/bash): the point is to catch a number edited out of step, and a
# per-format parser would need jq/yq/cfn-lint just to read one scalar.
check() {
  local what="$1" expected="$2" file="$3" pattern="$4" line lineno
  if [ ! -f "$file" ]; then
    echo "::error::$file missing — cannot verify $what"
    fail=1
    return
  fi
  # Match against the line CONTENT only. Grepping a `grep -n` result for the
  # expected number lets the line NUMBER satisfy the assertion — that false pass
  # shipped in the first draft of this script and hid a reverted GCE disk size.
  line="$(grep -E "$pattern" "$file" | head -1 || true)"
  lineno="$(grep -nE "$pattern" "$file" | head -1 | cut -d: -f1 || true)"
  if [ -z "$line" ]; then
    echo "::error::$file: no line matching /$pattern/ — $what is not wired at all"
    fail=1
    return
  fi
  if printf '%s' "$line" | grep -qE "(^|[^0-9])${expected}([^0-9]|$)"; then
    echo "  ✓ $what → $file ($expected)"
  else
    echo "::error::$file:${lineno}: $what should be $expected, found: $line"
    fail=1
  fi
}

echo "Datastore sizing (ci/storage-defaults.env):"

# --- Artifacts that provision storage ---------------------------------------

# AWS CloudFormation quick-launch: RDS allocated + autoscaling ceiling.
#
# Read each parameter's OWN Default rather than grepping the file for a number:
# a positional match would keep passing if a new numeric parameter were added
# above these, while silently checking the wrong one.
#
# check_cfn_param <description> <expected> <ParameterName>
check_cfn_param() {
  local what="$1" expected="$2" param="$3" found
  local file=aws/anyray-quicklaunch.template.yaml
  found="$(awk -v p="  ${param}:" '
    $0 == p { inblock = 1; next }
    inblock && /^  [A-Za-z]/ { exit }                 # next parameter, Default missing
    inblock && $1 == "Default:" { print $2; exit }
  ' "$file")"
  if [ -z "$found" ]; then
    echo "::error::$file: parameter $param has no Default — $what is unset"
    fail=1
  elif [ "$found" = "$expected" ]; then
    echo "  ✓ $what → $file ($param = $expected)"
  else
    echo "::error::$file: $what ($param) should default to $expected, found $found"
    fail=1
  fi
}

check_cfn_param "RDS allocated storage" "$ANYRAY_DB_STORAGE_GB" DbAllocatedStorage
check_cfn_param "RDS autoscaling ceiling" "$ANYRAY_DB_MAX_STORAGE_GB" DbMaxAllocatedStorage

# setup.sh --k8s writes the generated values file every scripted Helm install
# uses. This is the lever that gives NEW installs a real size without touching
# the chart default (see the carve-out below).
check "generated Helm values postgres.storage" "$ANYRAY_DB_STORAGE_GB" \
  setup.sh 'storage: \$\{DB_STORAGE_GB\}Gi|DB_STORAGE_GB="\$\{ANYRAY_DB_STORAGE_GB'

# The GKE / AKS one-click scripts write their own values overlay, so they need
# the same line independently of setup.sh.
check "GKE overlay postgres.storage" "$ANYRAY_DB_STORAGE_GB" \
  gcp/deploy.sh 'DB_STORAGE_GB="\$\{ANYRAY_DB_STORAGE_GB'
check "AKS overlay postgres.storage" "$ANYRAY_DB_STORAGE_GB" \
  azure/deploy.sh 'DB_STORAGE_GB="\$\{ANYRAY_DB_STORAGE_GB'

# Single-VM install: the persistent data disk holds Docker's data-root, so it
# carries the Postgres volume plus the gateway/optimizer /data volumes.
check "GCE data-disk size" "$ANYRAY_VM_DATA_DISK_GB" \
  gcp/gce/deploy.sh 'DISK_SIZE="\$\{DISK_SIZE'

# --- The carve-out ----------------------------------------------------------
#
# The Helm CHART default must STAY at its pinned value. Postgres is a
# StatefulSet and its size lands in a volumeClaimTemplate, which Kubernetes
# makes immutable. Raising the chart default would make the next `helm upgrade`
# fail for every existing install that never pinned postgres.storage, with an
# opaque "updates to statefulset spec for fields other than 'replicas' are
# forbidden" error — and self-hosted clients upgrade unattended, on their own
# schedule. New installs get the real size from the generated values file
# instead, which is checked above.
#
# So this assertion runs the OPPOSITE direction from the rest: it fails if
# someone "helpfully" syncs the chart default to ANYRAY_DB_STORAGE_GB.
chart_storage="$(grep -E '^[[:space:]]{2}storage:' helm/values.yaml | head -1 | awk '{print $2}')"
if [ "$chart_storage" = "$ANYRAY_HELM_CHART_DEFAULT_STORAGE" ]; then
  echo "  ✓ Helm chart default held at $ANYRAY_HELM_CHART_DEFAULT_STORAGE (upgrade-safety carve-out)"
else
  echo "::error::helm/values.yaml postgres.storage is '$chart_storage', expected '$ANYRAY_HELM_CHART_DEFAULT_STORAGE'."
  echo "::error::Raising the CHART default breaks 'helm upgrade' for existing installs (immutable"
  echo "::error::volumeClaimTemplate). Size new installs through the generated values file instead;"
  echo "::error::see the carve-out note in ci/storage-defaults.env."
  fail=1
fi

# --- End-to-end: the size the generator actually emits ----------------------
#
# Everything above checks SOURCE lines. This checks the artifact a real install
# consumes, so a generator that renders the wrong value (or stops emitting the
# block at all) still fails. Skipped when the file is absent, because the gate
# must also run on a bare checkout; CI renders it first, exactly as the
# env-coverage job does.
if [ -f my-values.yaml ]; then
  check "generated my-values.yaml postgres.storage" "$ANYRAY_DB_STORAGE_GB" \
    my-values.yaml '^[[:space:]]+storage:[[:space:]]*[0-9]+Gi'
else
  echo "  · my-values.yaml not rendered — skipping the generated-values check"
  echo "    (run ./setup.sh --k8s --connect adt_… --host … first to include it)"
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "Storage defaults are out of sync. Update ci/storage-defaults.env and every artifact together."
  exit 1
fi

echo "All storage defaults in sync."
