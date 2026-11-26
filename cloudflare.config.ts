import { readFileSync } from "node:fs";
import { bindings, defineConfig } from "cf/config";

interface CommentsConfig {
  enabled: boolean;
  d1_database_name?: string;
  d1_database_id?: string;
  r2_bucket_name?: string | null;
  turnstile_sitekey?: string;
  allowed_hostnames?: string[];
  preview_d1_database_name?: string;
  preview_d1_database_id?: string;
  preview_r2_bucket_name?: string | null;
  preview_turnstile_sitekey?: string;
  preview_allowed_hostnames?: string[];
}

interface SiteRegistryEntry {
  worker_name: string;
  preview_worker_name: string;
  base_url: string;
  environment: string;
  preview_environment: string;
  comments?: CommentsConfig;
}

interface SiteRegistry {
  sites: Record<string, SiteRegistryEntry>;
}

function normalizeOptionalString(val: unknown, label: string): string {
  if (val === undefined || val === null) return "";
  if (typeof val !== "string") {
    throw new Error(`Invalid ${label}: expected string or null.`);
  }
  return val.trim();
}

const registry: SiteRegistry = JSON.parse(
  readFileSync(new URL("./sites/sites.json", import.meta.url), "utf8")
);

export default defineConfig(({ isPreview: contextIsPreview }) => {
  const target = (process.env.CF_SITE_TARGET || "demo").trim();
  const rawDeployKind = process.env.CF_DEPLOY_KIND?.trim();

  if (rawDeployKind && rawDeployKind !== "production" && rawDeployKind !== "preview") {
    throw new Error(
      `Invalid CF_DEPLOY_KIND '${rawDeployKind}': expected 'production' or 'preview'.`
    );
  }
  if (rawDeployKind && (rawDeployKind === "preview") !== Boolean(contextIsPreview)) {
    throw new Error(
      `Conflicting preview mode: Cloudflare CLI context has isPreview=${Boolean(contextIsPreview)} ` +
        `but CF_DEPLOY_KIND='${rawDeployKind}'.`
    );
  }

  const isPreview = Boolean(contextIsPreview);
  const deployKind = isPreview ? "preview" : "production";

  const entry = registry.sites[target];
  if (!entry) {
    throw new Error(
      `Unknown CF_SITE_TARGET '${target}': declare it in sites/sites.json first.`
    );
  }

  const expectedWorkerName = isPreview ? entry.preview_worker_name : entry.worker_name;
  if (!expectedWorkerName) {
    throw new Error(
      `Missing ${deployKind} Worker name for site '${target}' in sites/sites.json.`
    );
  }

  const requestedWorkerName = process.env.CF_WORKER_NAME?.trim();
  if (requestedWorkerName && requestedWorkerName !== expectedWorkerName) {
    throw new Error(
      `Worker mismatch guard: CF_WORKER_NAME='${requestedWorkerName}' does not match ` +
        `sites/sites.json ${deployKind} Worker '${expectedWorkerName}' for site '${target}'.`
    );
  }

  // Collect every site's release identifiers so no preview can ever target ANY site's live storage or Worker
  const allReleaseWorkers = new Set<string>();
  const allReleaseD1Ids = new Set<string>();
  const allReleaseD1Names = new Set<string>();
  const allReleaseR2Buckets = new Set<string>();
  for (const [siteKey, siteCfg] of Object.entries(registry.sites)) {
    if (siteCfg.worker_name?.trim()) allReleaseWorkers.add(siteCfg.worker_name.trim());
    const c = siteCfg.comments;
    if (c) {
      const d1Id = normalizeOptionalString(c.d1_database_id, `sites.${siteKey}.comments.d1_database_id`);
      const d1Name = normalizeOptionalString(c.d1_database_name, `sites.${siteKey}.comments.d1_database_name`);
      const r2 = normalizeOptionalString(c.r2_bucket_name, `sites.${siteKey}.comments.r2_bucket_name`);
      if (d1Id) allReleaseD1Ids.add(d1Id);
      if (d1Name) allReleaseD1Names.add(d1Name);
      if (r2) allReleaseR2Buckets.add(r2);
    }
  }

  const catalogPath = new URL(`./sites/${target}/catalog.json`, import.meta.url);
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const siteAuthor = String(catalog?.site?.author || "");
  const comments = entry.comments;

  const releaseD1Id = normalizeOptionalString(comments?.d1_database_id, "comments.d1_database_id");
  const releaseD1Name = normalizeOptionalString(comments?.d1_database_name, "comments.d1_database_name");
  const releaseR2Bucket = normalizeOptionalString(comments?.r2_bucket_name, "comments.r2_bucket_name");

  const previewD1Id = normalizeOptionalString(comments?.preview_d1_database_id, "comments.preview_d1_database_id");
  const previewD1Name = normalizeOptionalString(comments?.preview_d1_database_name, "comments.preview_d1_database_name");
  const previewR2Bucket = normalizeOptionalString(comments?.preview_r2_bucket_name, "comments.preview_r2_bucket_name");

  if (isPreview) {
    if (allReleaseWorkers.has(expectedWorkerName)) {
      throw new Error(
        `Preview isolation guard: preview Worker '${expectedWorkerName}' matches a release Worker in sites/sites.json.`
      );
    }
    if (previewD1Id && allReleaseD1Ids.has(previewD1Id)) {
      throw new Error(
        `Preview isolation guard: comments.preview_d1_database_id '${previewD1Id}' matches a release D1 database in sites/sites.json.`
      );
    }
    if (previewD1Name && allReleaseD1Names.has(previewD1Name)) {
      throw new Error(
        `Preview isolation guard: comments.preview_d1_database_name '${previewD1Name}' matches a release D1 database name in sites/sites.json.`
      );
    }
    if (previewR2Bucket && allReleaseR2Buckets.has(previewR2Bucket)) {
      throw new Error(
        `Preview isolation guard: comments.preview_r2_bucket_name '${previewR2Bucket}' matches a release R2 bucket in sites/sites.json.`
      );
    }
  }

  // Previews NEVER bind release D1/R2 storage; they run Worker+D1 only when dedicated preview_* storage is declared.
  const activeD1Id = isPreview ? previewD1Id : releaseD1Id;
  const activeD1Name = isPreview ? previewD1Name : releaseD1Name;
  const activeR2Bucket = isPreview ? previewR2Bucket : releaseR2Bucket;
  const activeSitekey = isPreview
    ? normalizeOptionalString(comments?.preview_turnstile_sitekey, "comments.preview_turnstile_sitekey")
    : normalizeOptionalString(comments?.turnstile_sitekey, "comments.turnstile_sitekey");
  const activeAllowedHosts = isPreview
    ? comments?.preview_allowed_hostnames || []
    : comments?.allowed_hostnames || [];

  const commentsEnabled = Boolean(comments?.enabled && activeD1Id);
  const rateLimitNamespace = isPreview
    ? target === "prod"
      ? "2001"
      : "2002"
    : target === "prod"
      ? "1001"
      : "1002";

  return {
    worker: {
      name: expectedWorkerName,
      compatibilityDate: "2026-11-25",
      entrypoint: commentsEnabled ? "./worker/index.mjs" : undefined,
      observability: {
        enabled: true,
        logs: { enabled: true },
        traces: { enabled: true },
      },
      assets: {
        htmlHandling: "auto-trailing-slash",
        notFoundHandling: "404-page",
        runWorkerFirst: commentsEnabled ? ["/api/comments", "/api/comments/*"] : undefined,
      },
      env: commentsEnabled
        ? {
            ASSETS: bindings.assets(),
            COMMENTS_DB: bindings.d1({
              id: activeD1Id,
              name: activeD1Name || undefined,
            }),
            COMMENTS_IMAGES: activeR2Bucket
              ? bindings.r2({
                  name: activeR2Bucket,
                })
              : undefined,
            COMMENT_RATE_LIMIT: bindings.rateLimit({
              namespace: rateLimitNamespace,
              simple: { limit: 12, period: 60 },
            }),
            SITE_ID: bindings.text(isPreview ? `${target}-preview` : target),
            SITE_AUTHOR: bindings.text(siteAuthor),
            TURNSTILE_SITEKEY: bindings.text(activeSitekey),
            TURNSTILE_HOSTNAMES: bindings.text(activeAllowedHosts.join(",")),
          }
        : undefined,
    },
  };
});
