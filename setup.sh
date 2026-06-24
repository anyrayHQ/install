#!/usr/bin/env bash
# Anyray setup — generates every secret the stack needs.
# Default: writes .env for docker compose.
# With --k8s: writes anyray-secrets.yaml + my-values.yaml for Helm.
# With --connect <adt_token>: also links this deployment to Anyray Cloud
#   (token from https://app.anyray.ai). Safe to re-run to reconnect.
# With --upstream <url>: point Anyray at an existing OpenAI-compatible gateway
#   (LiteLLM, OpenRouter, …) so clients send plain requests with NO per-request
#   x-anyray-config header. Safe to re-run to change the upstream.
# Idempotent: never overwrites existing secrets; --connect (re)writes only the
# Anyray Cloud connect vars and --upstream only the upstream vars. Flags: --host
# <h> --k8s --namespace <namespace> --connect <adt_token>
# --gateway-url <url> --upstream <url>.
# (--control-plane <url> is DEV/INTERNAL ONLY: the vendor host is pinned +
# defaulted in the gateway image, so a normal connect never needs it; passing it
# only does anything for an internal/dev gateway build via the unsafe override
# below.)
set -euo pipefail

HOST=""
K8S=0
CONNECT_TOKEN=""
CONTROL_PLANE="https://app.anyray.ai"
GATEWAY_URL=""
UPSTREAM_URL=""
NAMESPACE=""

usage() {
  cat <<'EOF'
Usage: ./setup.sh [options]

Options:
  --host <hostname-or-ip>         Host users reach for Docker/VM installs.
  --k8s                          Generate Kubernetes Secret + Helm values.
  --namespace <namespace>         Existing Kubernetes namespace for --k8s.
  --connect <adt_token>           Connect deployment to Anyray Portal.
  --gateway-url <url>             Public gateway URL shown to developers.
  --upstream <url>                Seed an OpenAI-compatible upstream gateway.
  --control-plane <url>           Dev/internal control plane only.
  -h, --help                      Show this help.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --host) HOST="${2:?--host needs a value}"; shift 2 ;;
    --k8s)  K8S=1; shift ;;
    --namespace)     NAMESPACE="${2:?--namespace needs a Kubernetes namespace}"; shift 2 ;;
    --connect)       CONNECT_TOKEN="${2:?--connect needs a deployment token (adt_…)}"; shift 2 ;;
    --control-plane) CONTROL_PLANE="${2:?--control-plane needs a URL}"; shift 2 ;;
    --gateway-url)   GATEWAY_URL="${2:?--gateway-url needs a URL}"; shift 2 ;;
    --upstream)      UPSTREAM_URL="${2:?--upstream needs a URL (e.g. http://host.docker.internal:4000)}"; shift 2 ;;
    *) echo "✗ unknown flag: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# Every Anyray deployment connects to Anyray Portal for content-free usage metering
# (a product invariant). Metering is ON by default, so an install with no deployment
# token serves through the first-boot grace window and then blocks /v1 until a token
# is wired. Warn loudly here rather than hard-fail — the gateway-less attach mode
# (docker-compose.attach.yml) legitimately runs setup.sh without --connect.
if [ -z "$CONNECT_TOKEN" ]; then
  echo "⚠ No --connect token. Every Anyray deployment connects to Anyray Portal for" >&2
  echo "  content-free usage metering (counts/aggregates only — never content), which" >&2
  echo "  is ON by default. Without a deployment token the gateway serves through the" >&2
  echo "  first-boot grace window, then blocks /v1. Get a token at https://app.anyray.ai" >&2
  echo "  (Deployments → Connect a deployment) and re-run: ./setup.sh --connect <adt_…> …" >&2
  echo "  (Ignore this only for gateway-less attach mode.)" >&2
fi

if [ "$K8S" -eq 1 ] && [ -n "$UPSTREAM_URL" ]; then
  echo "✗ --upstream supports the docker compose flow only (set upstream.url in my-values.yaml for Helm)" >&2
  exit 1
fi

if [ "$K8S" -eq 0 ] && [ -n "$NAMESPACE" ]; then
  echo "✗ --namespace supports the Kubernetes/Helm flow only; add --k8s or remove --namespace" >&2
  exit 1
fi

if [ -n "$NAMESPACE" ]; then
  if [ ${#NAMESPACE} -gt 63 ] || ! printf '%s' "$NAMESPACE" | grep -Eq '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'; then
    echo "✗ --namespace must be a valid Kubernetes namespace name (DNS label, max 63 chars)" >&2
    exit 1
  fi
fi

command -v openssl >/dev/null 2>&1 || { echo "✗ openssl not found" >&2; exit 1; }

if [ "$K8S" -eq 0 ]; then
  command -v docker >/dev/null 2>&1 || { echo "✗ docker not found — https://docs.docker.com/engine/install/" >&2; exit 1; }
  docker compose version >/dev/null 2>&1 || { echo "✗ docker compose v2 not found — https://docs.docker.com/compose/install/" >&2; exit 1; }
fi

if [ "$K8S" -eq 1 ]; then
  # On Kubernetes, --host is the cluster's external Ingress/LoadBalancer DNS
  # endpoint. It is baked into the chart's Ingress host: rule, which matches on
  # the HTTP Host header — a raw IP is invalid there. Never auto-detect: the
  # machine running setup.sh is usually a kubectl client, not a cluster node, so
  # its local IP is meaningless to the cluster.
  if [ -z "$HOST" ]; then
    echo "✗ --host is required with --k8s — pass your cluster's external ingress hostname" >&2
    echo "  e.g. ./setup.sh --k8s --host anyray.example.com" >&2
    exit 1
  fi
  case "$HOST" in
    *[!0-9.]*) : ;;  # has a non-IPv4 character → a hostname, good
    *) echo "⚠ --host \"$HOST\" looks like an IP — that only works for the NodePort dev" >&2
       echo "  fallback. For Ingress/LoadBalancer, use the cluster's DNS endpoint." >&2 ;;
  esac
  if [ -z "$NAMESPACE" ]; then
    echo "ℹ No --namespace set; using your current kubectl/Helm namespace."
    echo "  To install elsewhere, pass --namespace <existing-namespace>."
  fi
elif [ -z "$HOST" ]; then
  HOST="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  # macOS: hostname has no -I — fall back to the primary interface address so
  # the gateway URL shown to developers is reachable, not "localhost".
  [ -n "$HOST" ] || HOST="$(ipconfig getifaddr en0 2>/dev/null || true)"
  [ -n "$HOST" ] || HOST=localhost
fi

hex() { openssl rand -hex "$1"; }
b64() { openssl rand -base64 32; }
b64enc() { printf '%s' "$1" | base64 | tr -d '\n'; }

get_env() { sed -n "s/^$1=//p" .env 2>/dev/null | head -n1; }

# Append KEY=VALUE only when absent — backfills new vars without rotating existing secrets.
add_if_missing() {
  if grep -q "^$1=" .env 2>/dev/null; then return 0; fi
  if [ "${ADDED:-0}" -eq 0 ] && [ "${NEW_ENV:-0}" -eq 0 ]; then
    printf '\n# Backfilled by a later setup.sh run (previously missing):\n' >> .env
  fi
  printf '%s=%s\n' "$1" "$2" >> .env
  ADDED=$((${ADDED:-0} + 1))
  echo "  + $1"
}

# Datastore secret (KEY VALUE VOLUME): never mint a NEW one when the store's volume already exists — a fresh value can't match the password Postgres stored at init.
add_secret() {
  if grep -q "^$1=" .env 2>/dev/null; then return 0; fi
  if docker volume inspect "$3" >/dev/null 2>&1; then DRIFT+=("$1 (existing volume $3)"); return 0; fi
  add_if_missing "$1" "$2"
}

# Helm values stub (no secrets). With --connect, also turns metering on; the
# deployment token + pseudonym salt live in anyray-secrets.yaml.
write_values_stub() {
  {
    echo "# Anyray Helm values — safe to commit (no secrets here)."
    if [ -n "$NAMESPACE" ]; then
      echo "# Namespace: ${NAMESPACE} (set with kubectl -n / helm --namespace; not a Helm value)."
    fi
    echo "host: \"${HOST}\""
    echo ""
    echo "image:"
    echo "  tag: \"latest\""
    if [ -n "$CONNECT_TOKEN" ]; then
      echo ""
      echo "# Anyray Cloud metering — deployment token + pseudonym salt live in anyray-secrets.yaml."
      echo "gateway:"
      echo "  metering:"
      echo "    enabled: true"
    fi
  } > my-values.yaml
}

# Ensure gateway.metering.enabled: true in an existing Helm values file while
# keeping every other line — used when --connect re-runs against a my-values.yaml
# that's already there. Assumes the 2-space structure setup.sh emits; handles a
# missing gateway: block, a gateway: without metering:, and an existing enabled:
# flag (flipped to true).
enable_metering() {
  awk '
    function flush_gw() {
      if (in_gw && !done) {
        if (!met_seen)     { print "  metering:"; print "    enabled: true"; done=1 }
        else if (!en_seen) { print "    enabled: true"; done=1 }
      }
    }
    /^[^[:space:]#]/ && !/^gateway:[[:space:]]*$/ { flush_gw(); in_gw=0; in_met=0 }
    /^gateway:[[:space:]]*$/ { flush_gw(); in_gw=1; gw_seen=1; met_seen=0; en_seen=0; print; next }
    in_gw && /^  metering:[[:space:]]*$/ { in_met=1; met_seen=1; print; next }
    in_gw && in_met && /^    enabled:/ { print "    enabled: true"; en_seen=1; done=1; next }
    { print }
    END {
      flush_gw()
      if (!gw_seen) { print "gateway:"; print "  metering:"; print "    enabled: true" }
    }
  ' "$1" > "$1.tmp" && mv "$1.tmp" "$1"
}

set_secret_namespace() {
  [ -n "$NAMESPACE" ] || return 0
  awk -v ns="$NAMESPACE" '
    /^metadata:[[:space:]]*$/ { in_meta=1; wrote=0; print; next }
    in_meta && /^[[:space:]]+namespace:[[:space:]]*/ {
      if (!wrote) { print "  namespace: " ns; wrote=1 }
      next
    }
    in_meta && /^[[:space:]]+name:[[:space:]]*/ {
      print
      if (!wrote) { print "  namespace: " ns; wrote=1 }
      next
    }
    in_meta && /^[^[:space:]]/ {
      if (!wrote) { print "  namespace: " ns; wrote=1 }
      in_meta=0
      print
      next
    }
    { print }
    END {
      if (in_meta && !wrote) { print "  namespace: " ns }
    }
  ' "$1" > "$1.tmp" && mv "$1.tmp" "$1"
}

kubectl_apply_command() {
  if [ -n "$NAMESPACE" ]; then
    echo "kubectl apply -n ${NAMESPACE} -f anyray-secrets.yaml"
  else
    echo "kubectl apply -f anyray-secrets.yaml"
  fi
}

helm_install_command() {
  if [ -n "$NAMESPACE" ]; then
    echo "helm install anyray ./helm -f my-values.yaml --namespace ${NAMESPACE}"
  else
    echo "helm install anyray ./helm -f my-values.yaml"
  fi
}

helm_upgrade_command() {
  if [ -n "$NAMESPACE" ]; then
    echo "helm upgrade anyray ./helm -f my-values.yaml --namespace ${NAMESPACE}"
  else
    echo "helm upgrade anyray ./helm -f my-values.yaml"
  fi
}

# ── Docker Compose mode ──────────────────────────────────────────────────────
if [ "$K8S" -eq 0 ]; then
  NEW_ENV=0
  ADDED=0
  DRIFT=()
  if [ ! -f .env ]; then
    NEW_ENV=1
    if [ -z "${DOCKER_HOST:-}" ] && command -v lsof >/dev/null 2>&1; then
      for p in 3000 8787; do
        if lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
          echo "⚠ port $p is already in use on this machine — the stack may fail to start"
        fi
      done
    fi
    {
      echo "# Generated by setup.sh — do not commit. Re-run setup.sh to backfill new vars."
      echo "# Console: http://${HOST}:3000"
      echo ""
    } > .env
    chmod 600 .env
  fi

  # Reconcile: add only missing vars (existing values untouched).
  add_if_missing ANYRAY_OPTIMIZER_TOKEN          "$(hex 32)"
  add_if_missing ANYRAY_CONTENT_KEY              "$(hex 32)"
  add_if_missing ANYRAY_CONTENT_MODE             "encrypted"
  add_if_missing ANYRAY_ALLOW_PLAINTEXT          "false"
  add_if_missing ANYRAY_ADMIN_TOKEN              "ar-adm-$(hex 16)"
  add_secret     POSTGRES_PASSWORD               "$(hex 16)" anyray_anyray_postgres_data
  chmod 600 .env

  if [ "${#DRIFT[@]}" -gt 0 ]; then
    echo "" >&2
    echo "✗ A datastore volume already exists but its password is missing from .env:" >&2
    for d in "${DRIFT[@]}"; do echo "    $d" >&2; done
    echo "  Generating a new password would NOT match the data already on disk (Postgres" >&2
    echo "  stores it at first init), so the apps could not authenticate. Resolve one of" >&2
    echo "  these, then re-run ./setup.sh:" >&2
    echo "    • Restore the .env that matches this volume (keeps data + password in sync)" >&2
    echo "    • Wipe the data for a clean start:  docker compose down -v   (DELETES all data)" >&2
    echo "    • Re-key the live store to a new password (advanced; see docs.anyray.ai)" >&2
    exit 1
  fi

  if [ "$NEW_ENV" -eq 1 ]; then
    cat >> .env <<'EOF'

# Opt-in updater — one-click + auto-update from the console. DEFAULT OFF.
# The stack uses the moving latest channel by default. To enable updates,
# uncomment the token below (any random secret, e.g. openssl rand -hex 32),
# then start it with
#   docker compose --profile updater up -d
# Docs: docs.anyray.ai -> Configure -> Updates, and Security -> the Docker socket.
# ANYRAY_UPDATER_TOKEN=
# ANYRAY_UPDATER_PERIODIC_POLLS=false
# ANYRAY_UPDATER_POLL_INTERVAL=86400
EOF
    echo "✓ Secrets generated → .env"
    echo ""
    echo "  Console:   http://${HOST}:3000"
    echo "  Admin key: $(get_env ANYRAY_ADMIN_TOKEN)   (also stored in .env as ANYRAY_ADMIN_TOKEN)"
    echo "  Gateway:   http://${HOST}:8787"
    [ -n "$CONNECT_TOKEN" ] || { echo ""; echo "  Next:      docker compose up -d"; }
    echo "  Verify:    ./scripts/verify-deploy.sh   (after 'docker compose up -d' — checks every leg)"
  elif [ "$ADDED" -gt 0 ]; then
    echo "✓ .env reconciled — added ${ADDED} missing variable(s); existing values kept"
    grep '^# Console:' .env | sed 's/^# //' || true
  else
    echo "✓ .env already complete — nothing to add; existing values kept"
    grep '^# Console:' .env | sed 's/^# //' || true
  fi

  # ── Anyray Cloud connect (--connect) ───────────────────────────────────────
  # (Re)writes only the connect vars below — every other line of .env is kept.
  if [ -n "$CONNECT_TOKEN" ]; then
    case "$CONNECT_TOKEN" in
      adt_*) : ;;
      *) echo "⚠ deployment token does not start with adt_ — double-check it against app.anyray.ai" ;;
    esac

    # The vendor's Ed25519 verify key and the control-plane host are PINNED in
    # the gateway image — they are no longer fetched or written here. That is
    # what makes the billing kill-switch tamper-resistant: re-pointing the URL
    # at a look-alike control plane gets nowhere, because the stock image won't
    # phone home to a non-pinned host and verifies leases only against the
    # baked-in key. So a custom --control-plane only works with an INTERNAL/DEV
    # gateway build, gated behind the unsafe override below.
    CANONICAL_CP="https://app.anyray.ai"
    CP_NORM="${CONTROL_PLANE%/}"

    # Pseudonym salt: generated locally and NEVER sent anywhere — it
    # pseudonymizes employee identifiers before metering. Reconnecting keeps
    # the existing salt so usage history stays attributable.
    PSEUDONYM_SALT="$(sed -n 's/^ANYRAY_PSEUDONYM_SALT=//p' .env | head -n 1)"
    [ -n "$PSEUDONYM_SALT" ] || PSEUDONYM_SALT="$(hex 32)"

    # The URL developers reach the gateway at — reported to the control plane
    # so the portal can show them the connect URL.
    if [ -z "$GATEWAY_URL" ]; then
      GATEWAY_URL="http://${HOST}:8787"
      # The auto-detected host is often a private/internal address (e.g. an
      # EC2/VPC 172.16–31.x or 10.x, or localhost). That is fine for devs ON the
      # same network, but developers off-VPC (remote, laptops) can't reach it —
      # and it's silently the URL the portal shows them. Flag it so the operator
      # passes --gateway-url with a reachable host (public DNS / VPN address).
      case "$HOST" in
        10.*|192.168.*|127.*|localhost|169.254.* \
          |172.1[6-9].*|172.2[0-9].*|172.3[0-1].*)
          echo "⚠ Gateway URL for developers is http://${HOST}:8787 — a private/internal"
          echo "  address. Devs off this network won't reach it. Re-run with"
          echo "  --gateway-url http://<reachable-host>:8787 (public DNS or VPN address)"
          echo "  to set the URL the portal shows them." ;;
      esac
    fi

    strip_env() { grep -v "^${1}=" .env > .env.tmp || true; mv .env.tmp .env; }
    for k in ANYRAY_METERING_ENABLED ANYRAY_CONTROL_PLANE_URL ANYRAY_DEPLOYMENT_TOKEN \
             ANYRAY_LICENSE_PUBLIC_KEY ANYRAY_DEV_UNSAFE_CONTROL_PLANE ANYRAY_PSEUDONYM_SALT \
             ANYRAY_GATEWAY_PUBLIC_URL ANYRAY_METERING_INTERVAL_MS ANYRAY_ENTITLEMENT_GRACE_MS; do
      strip_env "$k"
    done
    grep -v '^# Anyray Cloud (--connect)' .env > .env.tmp || true; mv .env.tmp .env

    # Common header + connect vars.
    cat >> .env <<EOF
# Anyray Cloud (--connect) — re-run ./setup.sh --connect <token> to reconnect.
ANYRAY_METERING_ENABLED=true
ANYRAY_DEPLOYMENT_TOKEN=${CONNECT_TOKEN}
ANYRAY_PSEUDONYM_SALT=${PSEUDONYM_SALT}
ANYRAY_GATEWAY_PUBLIC_URL=${GATEWAY_URL}
# Explicit values: docker-compose passes unset optional vars as empty strings,
# which gateways before v1.5.1 parse as 0 (metering every tick / zero grace).
ANYRAY_METERING_INTERVAL_MS=900000
ANYRAY_ENTITLEMENT_GRACE_MS=86400000
EOF

    if [ "$CP_NORM" = "$CANONICAL_CP" ]; then
      # Production connect. Newer gateway images PIN the control-plane host and
      # the Ed25519 verify key in the image, so they need neither here. But the
      # published images that customers pull TODAY read both from the
      # environment and SILENTLY skip metering (no log, no phone-home, no
      # billing) if either is missing — so we write the canonical host and the
      # vendor's verify-only key explicitly. This is safe and forward-compatible:
      #   • The host is the canonical vendor host — a pinned image validates it
      #     against its allowlist (passes) and a non-canonical host is REFUSED,
      #     so this never becomes a re-pointable trust knob.
      #   • The key is the vendor's PUBLIC verify-only key (it cannot sign
      #     leases). A pinned image ignores it entirely (an env key is honored
      #     only under ANYRAY_DEV_UNSAFE_CONTROL_PLANE=1, which we do NOT set);
      #     an older image verifies real vendor leases against it.
      # Keep this key in sync with PINNED_LICENSE_PUBLIC_KEY in the gateway's
      # licenseAnchor.ts (same key, distributed two ways).
      cat >> .env <<EOF
ANYRAY_CONTROL_PLANE_URL=${CANONICAL_CP}
ANYRAY_LICENSE_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAOScd41AewtCOmQSkT9N7Jn9V1u+uFykC/Vf8hnfKVPQ=\n-----END PUBLIC KEY-----\n"
EOF
    else
      # Custom control plane → dev/internal builds only. Enable the unsafe
      # override and fetch that control plane's verify key into .env (a stock
      # image ignores both; only a dev build honors them).
      echo "⚠ --control-plane ${CONTROL_PLANE} is not the Anyray control plane (${CANONICAL_CP})."
      echo "  A stock gateway image pins the vendor host + key and will REFUSE to meter against it."
      echo "  Enabling ANYRAY_DEV_UNSAFE_CONTROL_PLANE=1 — honored ONLY by an internal/dev gateway build."
      command -v curl >/dev/null 2>&1 || { echo "✗ curl not found — needed to fetch the dev control plane's verify key" >&2; exit 1; }
      # The verify key is no longer public — it is served only at the admin-gated
      # /admin/license-public-key. A dev operator runs the dev control plane, so
      # they hold its admin token: pass it as ANYRAY_CP_ADMIN_TOKEN. (Or skip the
      # fetch entirely by exporting ANYRAY_LICENSE_PUBLIC_KEY yourself.)
      if [ -z "${ANYRAY_CP_ADMIN_TOKEN:-}" ]; then
        echo "✗ --control-plane needs the dev control plane's admin token to fetch its verify key." >&2
        echo "  Set ANYRAY_CP_ADMIN_TOKEN=… and re-run, or set ANYRAY_LICENSE_PUBLIC_KEY=… yourself." >&2
        exit 1
      fi
      LICENSE_ENDPOINT="${CP_NORM}/admin/license-public-key"
      LICENSE_JSON="$(curl -fsSL --max-time 15 -H "Authorization: Bearer ${ANYRAY_CP_ADMIN_TOKEN}" "$LICENSE_ENDPOINT")" || {
        echo "✗ could not reach ${LICENSE_ENDPOINT} (check the URL, your network, and ANYRAY_CP_ADMIN_TOKEN), then re-run ./setup.sh --connect <token> --control-plane <url>" >&2
        exit 1
      }
      LICENSE_PEM="$(printf '%s' "$LICENSE_JSON" | tr -d '\n\r' | sed -n 's/.*"publicKeyPem"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
      case "$LICENSE_PEM" in
        *"BEGIN PUBLIC KEY"*) : ;;
        *) echo "✗ unexpected response from ${LICENSE_ENDPOINT} (no publicKeyPem) — is ${CONTROL_PLANE} really an Anyray control plane?" >&2; exit 1 ;;
      esac
      cat >> .env <<EOF
# Dev/staging ONLY — overrides the pinned vendor key + host. Never set in prod.
# The URL is written here (not in the common block) because it only takes effect
# under the override; a stock image ignores it and uses the pinned host.
ANYRAY_DEV_UNSAFE_CONTROL_PLANE=1
ANYRAY_CONTROL_PLANE_URL=${CONTROL_PLANE}
ANYRAY_LICENSE_PUBLIC_KEY="${LICENSE_PEM}"
EOF
    fi
    chmod 600 .env

    echo "✓ Connected to Anyray Cloud → .env (metering on; pseudonym salt stays local)"
    echo ""
    echo "  Next:      docker compose up -d"
    echo "  Then:      your deployment will appear as Connected at ${CONTROL_PLANE} within a minute"
    echo "  Gateway:   ${GATEWAY_URL}   (shown to developers in the portal)"
  fi

  # ── Upstream gateway (--upstream) ──────────────────────────────────────────
  # Point Anyray at an existing OpenAI-compatible gateway so clients send plain
  # requests with no x-anyray-config header: the gateway seeds its default
  # routing config from ANYRAY_UPSTREAM_URL on first boot, and the allowlist /
  # trusted-hosts vars clear the SSRF proxy guard for that host. (Re)writes only
  # these three vars — every other line of .env is kept.
  if [ -n "$UPSTREAM_URL" ]; then
    case "$UPSTREAM_URL" in
      http://*|https://*) : ;;
      *) echo "✗ --upstream must be a full URL, e.g. http://host.docker.internal:4000" >&2; exit 1 ;;
    esac

    # Hostname only — no scheme, userinfo, port, or path. The gateway matches the
    # allowlist on URL hostname, so a host:port entry would never match.
    up_rest="${UPSTREAM_URL#*://}"
    up_rest="${up_rest%%/*}"      # strip /path
    up_rest="${up_rest##*@}"      # strip user:pass@
    UP_HOST="${up_rest%%:*}"      # strip :port
    [ -n "$UP_HOST" ] || { echo "✗ could not parse a hostname from --upstream ${UPSTREAM_URL}" >&2; exit 1; }

    is_internal_host() {
      case "$1" in
        localhost|127.*|::1|host.docker.internal|10.*|192.168.* \
          |172.1[6-9].*|172.2[0-9].*|172.3[0-1].*|*.internal|*.local|*.corp) return 0 ;;
        *) return 1 ;;
      esac
    }

    for k in ANYRAY_UPSTREAM_URL ANYRAY_CUSTOM_HOST_ALLOWLIST TRUSTED_CUSTOM_HOSTS; do
      grep -v "^${k}=" .env > .env.tmp 2>/dev/null || true; mv .env.tmp .env
    done
    grep -v '^# Anyray upstream (--upstream)' .env > .env.tmp || true; mv .env.tmp .env

    {
      echo "# Anyray upstream (--upstream) — re-run ./setup.sh --upstream <url> to change."
      echo "ANYRAY_UPSTREAM_URL=${UPSTREAM_URL}"
      echo "ANYRAY_CUSTOM_HOST_ALLOWLIST=${UP_HOST}"
      if is_internal_host "$UP_HOST"; then
        # Gateway defaults to these when TRUSTED_CUSTOM_HOSTS is unset; setting it
        # replaces that set, so re-list the defaults and add the upstream host.
        trusted="localhost,127.0.0.1,::1,host.docker.internal"
        case ",${trusted}," in
          *",${UP_HOST},"*) : ;;
          *) trusted="${trusted},${UP_HOST}" ;;
        esac
        echo "TRUSTED_CUSTOM_HOSTS=${trusted}"
      fi
    } >> .env
    chmod 600 .env

    echo "✓ Upstream set → ${UPSTREAM_URL}  (clients need no x-anyray-config header)"
    is_internal_host "$UP_HOST" && echo "  Proxy guard cleared for internal host ${UP_HOST}"
    [ -n "$CONNECT_TOKEN" ] || { echo ""; echo "  Next:      docker compose up -d"; }
  fi
  exit 0
fi

# ── Kubernetes / Helm mode (--k8s) ───────────────────────────────────────────
# --connect <token> works here too: the deployment token + a locally-generated
# pseudonym salt are folded into anyray-secrets.yaml, and gateway.metering.enabled
# is turned on in my-values.yaml. The control-plane host and the vendor verify key
# stay PINNED in the gateway image — never written here.
if [ -n "$CONNECT_TOKEN" ]; then
  case "$CONNECT_TOKEN" in
    adt_*) : ;;
    *) echo "⚠ deployment token does not start with adt_ — double-check it against app.anyray.ai" ;;
  esac
fi

if [ -f anyray-secrets.yaml ]; then
  if [ -n "$NAMESPACE" ]; then
    set_secret_namespace anyray-secrets.yaml
    echo "✓ anyray-secrets.yaml already existed — set metadata.namespace to ${NAMESPACE} (secrets unchanged)"
  fi

  if [ -n "$CONNECT_TOKEN" ]; then
    # Fold the Anyray Cloud connect vars into the existing Secret IN PLACE — every
    # other key is kept, only the connect keys are (re)written. Reuse the existing
    # pseudonym salt so usage history stays attributable; mint one only on first
    # connect. (Mirrors the docker .env --connect path: re-runnable, idempotent.)
    EXISTING_SALT="$(sed -n 's/^[[:space:]]*ANYRAY_PSEUDONYM_SALT:[[:space:]]*//p' anyray-secrets.yaml | head -n 1)"
    grep -v -E '^[[:space:]]*ANYRAY_(DEPLOYMENT_TOKEN|PSEUDONYM_SALT):' anyray-secrets.yaml > anyray-secrets.yaml.tmp || true
    mv anyray-secrets.yaml.tmp anyray-secrets.yaml
    {
      echo "  ANYRAY_DEPLOYMENT_TOKEN: $(b64enc "$CONNECT_TOKEN")"
      if [ -n "$EXISTING_SALT" ]; then
        echo "  ANYRAY_PSEUDONYM_SALT: ${EXISTING_SALT}"
      else
        echo "  ANYRAY_PSEUDONYM_SALT: $(b64enc "$(hex 32)")"
      fi
    } >> anyray-secrets.yaml
    chmod 600 anyray-secrets.yaml
    echo "✓ anyray-secrets.yaml already existed — folded in Anyray Cloud connect vars (deployment token + pseudonym salt)"
    [ -n "$EXISTING_SALT" ] && echo "  (kept the existing pseudonym salt so usage history stays attributable)"

    if [ -f my-values.yaml ]; then
      enable_metering my-values.yaml
      echo "✓ my-values.yaml already existed — ensured gateway.metering.enabled: true"
    else
      write_values_stub
      echo "✓ Helm values stub → my-values.yaml (metering on)"
    fi
    echo ""
    echo "  Next:"
    echo "    $(kubectl_apply_command)"
    echo "    $(helm_upgrade_command)"
    echo ""
    echo "  Then:      this deployment appears as Connected at ${CONTROL_PLANE} within a minute"
  else
    if [ -z "$NAMESPACE" ]; then
      echo "✓ anyray-secrets.yaml already exists — leaving it untouched (delete it to regenerate)"
    fi
  fi
  exit 0
fi

ADMIN_TOKEN="ar-adm-$(hex 16)"
OPTIMIZER_TOKEN="$(hex 32)"
CONTENT_KEY="$(hex 32)"
POSTGRES_PW="$(hex 16)"

cat > anyray-secrets.yaml <<EOF
# Generated by setup.sh --k8s — do not commit. Delete and re-run to rotate.
apiVersion: v1
kind: Secret
metadata:
  name: anyray-secrets
type: Opaque
data:
  ANYRAY_ADMIN_TOKEN: $(b64enc "$ADMIN_TOKEN")
  ANYRAY_OPTIMIZER_TOKEN: $(b64enc "$OPTIMIZER_TOKEN")
  ANYRAY_CONTENT_KEY: $(b64enc "$CONTENT_KEY")
  POSTGRES_PASSWORD: $(b64enc "$POSTGRES_PW")
EOF

# Anyray Cloud connect (--connect): fold the deployment token + a locally-generated
# pseudonym salt into the Secret. The salt NEVER leaves your cluster — it
# pseudonymizes employee identifiers before the content-free usage rollup. The
# gateway reads these only when gateway.metering.enabled is set (below).
if [ -n "$CONNECT_TOKEN" ]; then
  PSEUDONYM_SALT="$(hex 32)"
  cat >> anyray-secrets.yaml <<EOF
  ANYRAY_DEPLOYMENT_TOKEN: $(b64enc "$CONNECT_TOKEN")
  ANYRAY_PSEUDONYM_SALT: $(b64enc "$PSEUDONYM_SALT")
EOF
fi
set_secret_namespace anyray-secrets.yaml
chmod 600 anyray-secrets.yaml

echo "✓ Secrets generated → anyray-secrets.yaml"
[ -n "$NAMESPACE" ] && echo "  Namespace: ${NAMESPACE} (must already exist; setup.sh does not create it)"
[ -n "$CONNECT_TOKEN" ] && echo "  ✓ Anyray Cloud connect vars folded in (deployment token + pseudonym salt)"

if [ -f my-values.yaml ]; then
  if [ -n "$CONNECT_TOKEN" ]; then
    enable_metering my-values.yaml
    echo "✓ my-values.yaml already existed — ensured gateway.metering.enabled: true"
  else
    echo "✓ my-values.yaml already exists — leaving it untouched"
  fi
else
  write_values_stub
  echo "✓ Helm values stub → my-values.yaml"
fi
echo ""
echo "  Next:"
echo "    $(kubectl_apply_command)"
echo "    $(helm_install_command)"
echo ""
echo "  Admin key: ${ADMIN_TOKEN}   (base64-encoded in anyray-secrets.yaml)"
echo "  Ingress:   console https://${HOST}/  gateway https://${HOST}/v1"
echo "  NodePort:  console http://${HOST}:30000  gateway http://${HOST}:30787 (if you set the NodePort values)"
[ -n "$CONNECT_TOKEN" ] && echo "  Then:      this deployment appears as Connected at ${CONTROL_PLANE} within a minute"
exit 0
