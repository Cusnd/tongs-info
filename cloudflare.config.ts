import { readFileSync } from "node:fs";
import { defineConfig } from "cf/config";

interface SiteRegistryEntry {
  worker_name: string;
  preview_worker_name: string;
  base_url: string;
  environment: string;
  preview_environment: string;
}

interface SiteRegistry {
  sites: Record<string, SiteRegistryEntry>;
}

const registry: SiteRegistry = JSON.parse(
  readFileSync(new URL("./sites/sites.json", import.meta.url), "utf8")
);

const target = process.env.CF_SITE_TARGET || "demo";
const deployKind = process.env.CF_DEPLOY_KIND || "production";

if (deployKind !== "production" && deployKind !== "preview") {
  throw new Error(
    `Invalid CF_DEPLOY_KIND '${deployKind}': expected 'production' or 'preview'.`
  );
}

const entry = registry.sites[target];
if (!entry) {
  throw new Error(
    `Unknown CF_SITE_TARGET '${target}': declare it in sites/sites.json first.`
  );
}

const expectedWorkerName =
  deployKind === "preview" ? entry.preview_worker_name : entry.worker_name;

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

export default defineConfig({
  worker: {
    name: expectedWorkerName,
    compatibilityDate: "2026-11-24",
    assets: {
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "404-page",
    },
  },
});
