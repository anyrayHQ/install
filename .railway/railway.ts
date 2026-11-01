import {
  defineRailway,
  group,
  image,
  postgres,
  preserve,
  project,
  service,
  volume,
} from "railway/iac";

// Anyray self-hosted stack as Railway Infrastructure-as-Code.
//
// The image tag is CI-owned: the monorepo prod promotion bumps the pinned
// vX.Y.Z across every install artifact (including this file) on each release,
// so `railway config apply` from this repo always provisions the current build.
//
// railway/railway-iac-bootstrap.sh handles these post-apply steps:
//   1. generated secrets — seeded once, then preserve()d here so apply never
//      clobbers them.
//   2. the operator's required Billing token.
//   3. generated public domains (gateway :8787, proxy :80) + the URLs that
//      reference them — created after apply, so ANYRAY_*_PUBLIC_URL are preserve()d.
//
// Private service-to-service hostnames are deterministic (<service>.railway.internal)
// so they are literals below — which also breaks the gateway<->optimizer reference
// cycle that plain object refs would create.

const TAG = "v1.10.550";
const ecr = (name: string) => image(`public.ecr.aws/anyray/${name}:${TAG}`);

export default defineRailway(() => {
  const db = postgres("Postgres");

  const gateway = service("gateway", {
    source: ecr("gateway"),
    healthcheck: "/",
    volumeMounts: { "/data": volume("gateway-data", { sizeMB: 1024 }) },
    env: {
      PORT: "8787",
      ANYRAY_OBSERVABILITY_DB_URL: db.env.DATABASE_URL,
      ANYRAY_SPEND_DB_URL: db.env.DATABASE_URL,
      ANYRAY_OPTIMIZER_URL: "http://optimizer.railway.internal:8088",
      ANYRAY_OPTIMIZER_TOKEN: preserve(), // canonical; optimizer references gateway.env.*
      ANYRAY_DEFAULT_MODEL: "anthropic/claude-sonnet-5-5",
      ANYRAY_CONTENT_KEY: preserve(),
      ANYRAY_CONTENT_MODE: "encrypted",
      ANYRAY_ALLOW_PLAINTEXT: "false",
      ANYRAY_ADMIN_TOKEN: preserve(),
      ANYRAY_METERING_ENABLED: "true",
      ANYRAY_DEPLOYMENT_TOKEN: preserve(), // adt_ token from app.anyray.ai (metering)
      ANYRAY_PSEUDONYM_SALT: preserve(),
      ANYRAY_DATA_DIR: "/data",
      ANYRAY_GATEWAY_PUBLIC_URL: preserve(), // bootstrap sets after domain generation
      ANYRAY_CONSOLE_PUBLIC_URL: preserve(), // bootstrap sets after domain generation
      ANYRAY_HSTS: "true",
      ANYRAY_TRUST_PROXY: "true",
      // How long Railway lets the outgoing container finish in-flight requests
      // on a redeploy. Must outlive the gateway's own SIGTERM drain
      // (ANYRAY_SHUTDOWN_DRAIN_MS, default 90s) or the kill lands mid-stream and
      // the developer's tool reports "Connection closed mid-response" against
      // the gateway rather than against the redeploy that caused it. Mirrors
      // railway/railway.template.json — keep the two in step.
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "120",
    },
  });

  const optimizer = service("optimizer", {
    source: ecr("optimizer"),
    healthcheck: "/health",
    volumeMounts: { "/data": volume("optimizer-data", { sizeMB: 1024 }) },
    env: {
      PORT: "8088",
      ANYRAY_OPTIMIZER_TOKEN: gateway.env.ANYRAY_OPTIMIZER_TOKEN,
      ANYRAY_ADMIN_TOKEN: gateway.env.ANYRAY_ADMIN_TOKEN,
      ANYRAY_CONTENT_KEY: gateway.env.ANYRAY_CONTENT_KEY,
      ANYRAY_CONTENT_MODE: "encrypted",
      ANYRAY_ALLOW_PLAINTEXT: "false",
      ANYRAY_SPEND_DB_URL: db.env.DATABASE_URL,
      ANYRAY_DATA_DIR: "/data",
      // Its own drain is 15s — an optimize call is bounded by the gateway's
      // ceiling on it, not by how long a model takes to answer.
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "30",
    },
  });

  const proxy = service("proxy", {
    source: ecr("proxy"),
    healthcheck: "/anyray-login",
    env: {
      ANYRAY_GATEWAY_HOST: "gateway.railway.internal",
      ANYRAY_OPTIMIZER_HOST: "optimizer.railway.internal",
      ANYRAY_UPDATER_ENABLED: "false",
      ANYRAY_UPDATER_PERIODIC_POLLS: "false",
      ANYRAY_UPDATER_POLL_INTERVAL: "0",
      ANYRAY_UPDATER_TOKEN: preserve(),
      // nginx drains its workers on SIGQUIT while still proxying console
      // responses; Railway's default would cut that short.
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "60",
    },
  });

  const anyray = group("Anyray", [gateway, optimizer, proxy, db]);

  return project("anyray", {
    resources: [anyray],
  });
});
