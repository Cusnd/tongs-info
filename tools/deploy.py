#!/usr/bin/env python3
"""
Tong's Information — Cross-Platform Cloudflare Workers + Static Assets Deployer

Security & safety guarantees:
- Validates target site against the reviewed `sites/sites.json` registry
- Enforces the EXACT registered Worker name per (site, deploy_kind) — rejects any unregistered or mismatched override
- Stages local runs into an owned per-invocation immutable directory (cleaned up on exit) so concurrent runs never race
- Inspects lexical roots, ancestors, and the entire staged bundle tree for symlinks/junctions before resolving/opening
- Recomputes bundle SHA-256 and verifies `api/release.json` (site, base_url, bundle_sha256, and GITHUB_SHA when in CI)
- When comments API is enabled, emits a zero-bundler Build Output Specification v1 tree under `.cloudflare/output/v1/`
  combining `worker/index.mjs` + staged static assets + D1/RateLimit bindings, and invokes `cf deploy --prebuilt`
- Requires the pinned local `node_modules/.bin/cf` CLI by default (unless `--allow-global-cf`)
- Serializes local `cf` invocations via retry-safe `.cloudflare/.deploy.lock`

Usage:
  python tools/deploy.py --site demo --dry-run
  python tools/deploy.py --site demo
  python tools/deploy.py --site prod --preview --preview-name pr-12-prod
  python tools/deploy.py --site prod --expect-base-url https://www.esoren.com
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Iterator

if os.name == "nt":
    import msvcrt
else:
    import fcntl

ROOT = Path(__file__).resolve().parent.parent
SITES_DIR = ROOT / "sites"
WORKER_ENTRY = ROOT / "worker" / "index.mjs"
REGISTRY_PATH = SITES_DIR / "sites.json"
DIST_DIR = ROOT / ".dist"
BUILD_OUTPUT_DIR = ROOT / ".cloudflare" / "output"
SITE_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def is_link_or_junction(path: Path) -> bool:
    if path.is_symlink():
        return True
    isjunction = getattr(os.path, "isjunction", None)
    if isjunction is not None:
        try:
            return bool(isjunction(path))
        except OSError:
            return False
    if os.name == "nt":
        try:
            attrs = getattr(os.lstat(path), "st_file_attributes", 0)
            return bool(attrs & 0x400)  # FILE_ATTRIBUTE_REPARSE_POINT
        except OSError:
            return False
    return False


def assert_lexical_tree_clean(root_dir: Path) -> None:
    """Reject symlinks/junctions on lexical root, its ancestors, and every descendant before opening files (M6)."""
    if is_link_or_junction(root_dir):
        raise ValueError(f"Staged root directory must not be a symlink or junction: {root_dir}")
    for ancestor in root_dir.parents:
        if is_link_or_junction(ancestor):
            raise ValueError(f"Staged root ancestor must not be a symlink or junction: {ancestor}")
    if not root_dir.is_dir():
        raise ValueError(f"Staged directory not found: {root_dir}")
    for dirpath, dirnames, filenames in os.walk(root_dir, followlinks=False):
        dp = Path(dirpath)
        for d in dirnames:
            cand = dp / d
            if is_link_or_junction(cand):
                raise ValueError(f"Staged bundle contains forbidden symlink/junction directory: {cand}")
        for f in filenames:
            cand = dp / f
            if is_link_or_junction(cand):
                raise ValueError(f"Staged bundle contains forbidden symlink/junction file: {cand}")


def compute_bundle_sha256(bundle_dir: Path) -> str:
    h = hashlib.sha256()
    for path in sorted(p for p in bundle_dir.rglob("*") if p.is_file()):
        rel = path.relative_to(bundle_dir).as_posix()
        if rel == "api/release.json":
            continue
        data = path.read_bytes()
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(str(len(data)).encode("ascii"))
        h.update(b"\0")
        h.update(data)
    return h.hexdigest()


@contextlib.contextmanager
def exclusive_lock(lock_path: Path, *, timeout_sec: float = 120.0) -> Iterator[None]:
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a+b") as fh:
        fh.seek(0)
        if os.name == "nt":
            fh.write(b"\0")
            fh.flush()
            deadline = time.monotonic() + timeout_sec
            while True:
                fh.seek(0)
                try:
                    msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(f"Timed out waiting for lock {lock_path} after {timeout_sec:.0f}s")
                    time.sleep(0.2)
            try:
                yield
            finally:
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


@contextlib.contextmanager
def deploy_lock(*, timeout_sec: float = 120.0) -> Iterator[None]:
    with exclusive_lock(ROOT / ".cloudflare" / ".deploy.lock", timeout_sec=timeout_sec):
        yield


def load_registry() -> dict[str, dict]:
    if not REGISTRY_PATH.is_file():
        raise RuntimeError(f"Missing site registry: {REGISTRY_PATH}")
    data = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    sites = data.get("sites")
    if not isinstance(sites, dict) or not sites:
        raise RuntimeError("sites/sites.json must contain a non-empty 'sites' object")
    return sites


def resolve_worker_name(
    site_name: str,
    registry: dict[str, dict],
    *,
    is_preview: bool,
    override: str | None,
) -> str:
    """Enforce exact match with the single reviewed Worker declared in sites/sites.json (B3)."""
    entry = registry[site_name]
    mode_key = "preview_worker_name" if is_preview else "worker_name"
    expected_name = str(entry.get(mode_key, "")).strip()
    if not expected_name:
        raise ValueError(f"sites/sites.json: missing '{mode_key}' for site '{site_name}'")

    if is_preview:
        all_release_workers = {
            str(other.get("worker_name", "")).strip()
            for other in registry.values()
            if isinstance(other, dict)
        } - {""}
        if expected_name in all_release_workers:
            raise ValueError(
                f"Preview isolation guard blocked deploy: preview Worker '{expected_name}' for site "
                f"'{site_name}' matches a release Worker declared in sites/sites.json."
            )

    requested = (override or os.environ.get("CF_WORKER_NAME") or "").strip()
    if requested and requested != expected_name:
        raise ValueError(
            f"Worker registry guard blocked deploy: requested Worker '{requested}' does not match "
            f"sites/sites.json '{mode_key}' ('{expected_name}') for site '{site_name}'. "
            "Edit sites/sites.json to change the Worker target."
        )
    return expected_name


def resolve_cf_command(*, allow_global: bool = False) -> list[str]:
    """Require pinned project-local node_modules/.bin/cf by default (Minor 10)."""
    local_bin = ROOT / "node_modules" / ".bin" / ("cf.cmd" if os.name == "nt" else "cf")
    if local_bin.is_file():
        return [str(local_bin)]
    if allow_global:
        global_cf = shutil.which("cf")
        if global_cf:
            return [global_cf]
    raise RuntimeError(
        "Pinned local Cloudflare CLI (node_modules/.bin/cf) not found. "
        "Run 'npm ci' first (or pass --allow-global-cf to opt into a global cf install)."
    )


def verify_staged_bundle(
    dist_dir: Path,
    site_name: str,
    expected_base_url: str,
    *,
    expected_git_sha: str | None = None,
) -> None:
    """Inspect tree for links, verify api/release.json metadata, and recompute bundle_sha256 (M5/M6)."""
    assert_lexical_tree_clean(dist_dir)

    release_path = dist_dir / "api" / "release.json"
    if not release_path.is_file():
        raise ValueError(
            f"Staged bundle '{dist_dir}' is missing api/release.json. "
            f"Run 'python tools/editorial_sync.py --site {site_name} --check --stage' first."
        )

    release = json.loads(release_path.read_text(encoding="utf-8"))
    if release.get("site") != site_name:
        raise ValueError(
            f"Staged bundle site mismatch: api/release.json is for '{release.get('site')}', expected '{site_name}'"
        )
    actual_base = str(release.get("base_url", "")).rstrip("/")
    expected_norm = expected_base_url.rstrip("/")
    if actual_base != expected_norm:
        raise ValueError(
            f"Staged bundle domain mismatch: api/release.json has '{actual_base}', expected '{expected_norm}'"
        )

    recorded_sha = str(release.get("bundle_sha256", "")).strip()
    if not recorded_sha:
        raise ValueError("Staged bundle api/release.json is missing bundle_sha256")
    actual_sha = compute_bundle_sha256(dist_dir)
    if actual_sha != recorded_sha:
        raise ValueError(
            f"Staged bundle integrity check failed: recomputed SHA-256 '{actual_sha}' "
            f"does not match api/release.json '{recorded_sha}'."
        )

    if expected_git_sha:
        recorded_git = str(release.get("git_sha", "")).strip()
        if recorded_git != expected_git_sha:
            raise ValueError(
                f"Staged bundle revision mismatch: api/release.json git_sha='{recorded_git}', "
                f"expected '{expected_git_sha}'"
            )


def _optional_trimmed_str(obj: dict, key: str, *, label: str) -> str:
    val = obj.get(key)
    if val is None:
        return ""
    if not isinstance(val, str):
        raise ValueError(f"{label}.{key} must be a string or null")
    return val.strip()


def resolve_comments_bindings(
    site_name: str,
    entry: dict,
    *,
    is_preview: bool,
    registry: dict[str, dict] | None = None,
) -> dict[str, object] | None:
    """
    Resolve comments Worker bindings with strict cross-site preview/release storage isolation.
    Previews NEVER bind any site's release D1/R2 storage; if isolated preview_* IDs are not configured,
    returns None so previews deploy safely in assets-only mode.
    """
    comments = entry.get("comments")
    if not isinstance(comments, dict) or not comments.get("enabled") or not WORKER_ENTRY.is_file():
        return None

    label = f"sites/sites.json: site '{site_name}' comments"
    release_d1_id = _optional_trimmed_str(comments, "d1_database_id", label=label)
    release_d1_name = _optional_trimmed_str(comments, "d1_database_name", label=label)
    release_r2_name = _optional_trimmed_str(comments, "r2_bucket_name", label=label)

    # Gather release resources across ALL registered sites so a preview cannot bind another site's live storage either
    all_release_d1_ids = {release_d1_id} if release_d1_id else set()
    all_release_d1_names = {release_d1_name} if release_d1_name else set()
    all_release_r2_names = {release_r2_name} if release_r2_name else set()
    if registry:
        for other_site, other_entry in registry.items():
            other_c = other_entry.get("comments")
            if isinstance(other_c, dict):
                other_lbl = f"sites/sites.json: site '{other_site}' comments"
                oid = _optional_trimmed_str(other_c, "d1_database_id", label=other_lbl)
                oname = _optional_trimmed_str(other_c, "d1_database_name", label=other_lbl)
                or2 = _optional_trimmed_str(other_c, "r2_bucket_name", label=other_lbl)
                if oid:
                    all_release_d1_ids.add(oid)
                if oname:
                    all_release_d1_names.add(oname)
                if or2:
                    all_release_r2_names.add(or2)

    if is_preview:
        d1_id = _optional_trimmed_str(comments, "preview_d1_database_id", label=label)
        d1_name = _optional_trimmed_str(comments, "preview_d1_database_name", label=label)
        r2_bucket_name = _optional_trimmed_str(comments, "preview_r2_bucket_name", label=label)
        if d1_id and d1_id in all_release_d1_ids:
            raise ValueError(f"{label}: preview_d1_database_id must not match any release d1_database_id")
        if d1_name and d1_name in all_release_d1_names:
            raise ValueError(f"{label}: preview_d1_database_name must not match any release d1_database_name")
        if r2_bucket_name and r2_bucket_name in all_release_r2_names:
            raise ValueError(f"{label}: preview_r2_bucket_name must not match any release r2_bucket_name")
        if not d1_id:
            return None
        if not d1_name:
            raise ValueError(f"{label}: preview_d1_database_id requires preview_d1_database_name")
        sitekey = _optional_trimmed_str(comments, "preview_turnstile_sitekey", label=label)
        allowed_hosts = [
            str(h).strip() for h in (comments.get("preview_allowed_hostnames") or []) if str(h).strip()
        ]
        rate_namespace = "2001" if site_name == "prod" else "2002"
        site_id = f"{site_name}-preview"
    else:
        d1_id = release_d1_id
        d1_name = release_d1_name
        r2_bucket_name = release_r2_name
        if not d1_id or not d1_name:
            raise ValueError(f"{label}: missing d1_database_id or d1_database_name")
        sitekey = _optional_trimmed_str(comments, "turnstile_sitekey", label=label)
        allowed_hosts = [str(h).strip() for h in (comments.get("allowed_hostnames") or []) if str(h).strip()]
        rate_namespace = "1001" if site_name == "prod" else "1002"
        site_id = site_name

    return {
        "d1_id": d1_id,
        "d1_name": d1_name,
        "r2_bucket_name": r2_bucket_name,
        "sitekey": sitekey,
        "allowed_hosts": allowed_hosts,
        "rate_namespace": rate_namespace,
        "site_id": site_id,
    }


def emit_prebuilt_worker_output(
    *,
    site_name: str,
    worker_name: str,
    bindings_cfg: dict[str, object],
    dist_dir: Path,
    is_preview: bool,
) -> None:
    """
    Assemble Cloudflare Build Output Specification v1 (`.cloudflare/output/v1/`) directly
    from `worker/index.mjs` + staged static assets — zero bundler, zero Wrangler config.
    """
    if not WORKER_ENTRY.is_file() or is_link_or_junction(WORKER_ENTRY):
        raise ValueError(f"Missing or unsafe Worker entrypoint: {WORKER_ENTRY}")

    d1_id = str(bindings_cfg["d1_id"])
    d1_name = str(bindings_cfg["d1_name"])
    r2_bucket_name = str(bindings_cfg["r2_bucket_name"])
    sitekey = str(bindings_cfg["sitekey"])
    allowed_hosts = list(bindings_cfg["allowed_hosts"])  # type: ignore[arg-type]
    rate_namespace = str(bindings_cfg["rate_namespace"])
    site_id = str(bindings_cfg["site_id"])

    catalog_path = SITES_DIR / site_name / "catalog.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    site_author = str(catalog.get("site", {}).get("author", "")).strip()

    v1_dir = BUILD_OUTPUT_DIR / "v1"
    worker_dir = v1_dir / "workers" / "default"
    bundle_dir = worker_dir / "bundle"
    assets_dir = worker_dir / "assets"

    if BUILD_OUTPUT_DIR.exists():
        shutil.rmtree(BUILD_OUTPUT_DIR)
    bundle_dir.mkdir(parents=True, exist_ok=True)

    shutil.copy2(WORKER_ENTRY, bundle_dir / "index.mjs")
    shutil.copytree(dist_dir, assets_dir, symlinks=False)

    root_config = {
        "producer": {"name": "tongs-info-deploy", "version": "1.0.0"},
        "buildContext": {"isPreview": is_preview},
    }
    (v1_dir / "config.json").write_text(
        json.dumps(root_config, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )

    worker_env: dict[str, object] = {
        "ASSETS": {"type": "assets"},
        "COMMENTS_DB": {
            "type": "d1",
            "id": d1_id,
            "name": d1_name,
        },
        "COMMENT_RATE_LIMIT": {
            "type": "rate-limit",
            "namespace": rate_namespace,
            "simple": {"limit": 12, "period": 60},
        },
        "SITE_ID": {"type": "text", "value": site_id},
        "SITE_AUTHOR": {"type": "text", "value": site_author},
        "TURNSTILE_SITEKEY": {"type": "text", "value": sitekey},
        "TURNSTILE_HOSTNAMES": {"type": "text", "value": ",".join(allowed_hosts)},
    }
    if r2_bucket_name:
        worker_env["COMMENTS_IMAGES"] = {
            "type": "r2",
            "name": r2_bucket_name,
        }

    worker_config = {
        "name": worker_name,
        "compatibilityDate": "2026-11-25",
        "observability": {
            "enabled": True,
            "logs": {"enabled": True},
            "traces": {"enabled": True},
        },
        "assets": {
            "htmlHandling": "auto-trailing-slash",
            "notFoundHandling": "404-page",
            "runWorkerFirst": ["/api/comments", "/api/comments/*"],
        },
        "env": worker_env,
        "manifest": {
            "type": "complete",
            "mainModule": "index.mjs",
            "modules": {
                "index.mjs": {"type": "esm"},
            },
        },
    }
    (worker_dir / "worker.config.json").write_text(
        json.dumps(worker_config, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Stage and deploy a site via Cloudflare cf CLI")
    parser.add_argument("--site", required=True, help="Target site declared in sites/sites.json (e.g. demo, prod)")
    parser.add_argument("--worker-name", help="Must match sites/sites.json Worker name for this site & mode")
    parser.add_argument("--expect-base-url", help="Domain mismatch guard (must match sites/sites.json base_url)")
    parser.add_argument("--expect-git-sha", help="Require api/release.json git_sha to match this commit SHA")
    parser.add_argument("--dist-dir", help="Explicit immutable staged bundle directory")
    parser.add_argument("--preview", action="store_true", help="Deploy an ephemeral preview via 'cf previews deploy'")
    parser.add_argument("--preview-name", help="Explicit preview name passed to 'cf previews deploy --preview-name'")
    parser.add_argument("--tag", help="Worker Version tag passed to 'cf deploy --tag'")
    parser.add_argument("--message", help="Worker Version message passed to 'cf deploy --message'")
    parser.add_argument("--secrets-file", help="Optional JSON/.env secrets file passed to 'cf deploy --secrets-file'")
    parser.add_argument("--dry-run", action="store_true", help="Pass --dry-run to cf CLI (no remote mutation)")
    parser.add_argument("--skip-sync", action="store_true", help="Skip editorial_sync.py (still recomputes digest)")
    parser.add_argument("--allow-global-cf", action="store_true", help="Allow falling back to global cf binary")
    args = parser.parse_args(argv)

    site_name = args.site
    if not SITE_NAME_RE.match(site_name):
        print(f"[deploy] ERROR: invalid site name '{site_name}'")
        return 2

    try:
        registry = load_registry()
    except Exception as exc:
        print(f"[deploy] ERROR: {exc}")
        return 1

    if site_name not in registry:
        print(f"[deploy] ERROR: site '{site_name}' is not declared in sites/sites.json")
        return 2

    entry = registry[site_name]
    reg_base_url = str(entry["base_url"]).rstrip("/")
    expected_base_url = (args.expect_base_url or reg_base_url).rstrip("/")
    if expected_base_url != reg_base_url:
        print(
            f"[deploy:{site_name}] ERROR: --expect-base-url '{expected_base_url}' disagrees with "
            f"sites/sites.json base_url '{reg_base_url}'"
        )
        return 1

    try:
        worker_name = resolve_worker_name(
            site_name,
            registry,
            is_preview=args.preview,
            override=args.worker_name,
        )
        comments_bindings = resolve_comments_bindings(
            site_name,
            entry,
            is_preview=args.preview,
            registry=registry,
        )
    except ValueError as exc:
        print(f"[deploy:{site_name}] ERROR: {exc}")
        return 1

    comments_enabled = comments_bindings is not None
    owned_temp_stage: Path | None = None
    try:
        if args.dist_dir:
            dist_dir = Path(args.dist_dir)
            if not dist_dir.is_absolute():
                dist_dir = Path.cwd() / dist_dir
        elif not args.skip_sync:
            DIST_DIR.mkdir(parents=True, exist_ok=True)
            owned_temp_stage = Path(tempfile.mkdtemp(prefix=f".deploy-{site_name}-", dir=str(DIST_DIR)))
            owned_temp_stage.rmdir()
            dist_dir = owned_temp_stage
        else:
            dist_dir = DIST_DIR / site_name

        if not args.skip_sync:
            sync_cmd = [
                sys.executable,
                str(ROOT / "tools" / "editorial_sync.py"),
                "--site",
                site_name,
                "--check",
                "--stage-dir",
                str(dist_dir),
                "--expect-base-url",
                expected_base_url,
            ]
            rc = subprocess.run(sync_cmd, cwd=ROOT).returncode
            if rc != 0:
                return rc

        deploy_kind = "preview" if args.preview else "production"
        env = os.environ.copy()
        env["CF_SITE_TARGET"] = site_name
        env["CF_DEPLOY_KIND"] = deploy_kind
        env["CF_WORKER_NAME"] = worker_name

        cf_cmd = resolve_cf_command(allow_global=args.allow_global_cf)
        if comments_enabled:
            if args.preview:
                cf_cmd.extend(["previews", "deploy", "--prebuilt"])
                if args.preview_name:
                    cf_cmd.extend(["--preview-name", args.preview_name])
            else:
                cf_cmd.extend(["deploy", "--prebuilt"])
                if args.tag:
                    cf_cmd.extend(["--tag", args.tag])
                if args.message:
                    cf_cmd.extend(["--message", args.message])
            if args.secrets_file:
                cf_cmd.extend(["--secrets-file", str(Path(args.secrets_file).resolve())])
        else:
            if args.preview:
                cf_cmd.extend(["previews", "deploy", str(dist_dir)])
                if args.preview_name:
                    cf_cmd.extend(["--preview-name", args.preview_name])
            else:
                cf_cmd.extend(["deploy", str(dist_dir)])
                if args.tag:
                    cf_cmd.extend(["--tag", args.tag])
                if args.message:
                    cf_cmd.extend(["--message", args.message])

        if args.dry_run:
            cf_cmd.append("--dry-run")

        uses_shared_stage = args.skip_sync and not args.dist_dir
        stage_guard = (
            exclusive_lock(DIST_DIR / f".{site_name}.lock")
            if uses_shared_stage
            else contextlib.nullcontext()
        )
        with stage_guard, deploy_lock():
            verify_staged_bundle(
                dist_dir,
                site_name,
                expected_base_url,
                expected_git_sha=args.expect_git_sha,
            )
            if comments_enabled and comments_bindings is not None:
                emit_prebuilt_worker_output(
                    site_name=site_name,
                    worker_name=worker_name,
                    bindings_cfg=comments_bindings,
                    dist_dir=dist_dir,
                    is_preview=args.preview,
                )
            print(
                f"[deploy:{site_name}] Running: {' '.join(cf_cmd)} "
                f"(CF_SITE_TARGET={site_name}, CF_DEPLOY_KIND={deploy_kind}, "
                f"CF_WORKER_NAME={worker_name}, comments={'worker+assets' if comments_enabled else 'assets-only'})",
                flush=True,
            )
            return subprocess.run(cf_cmd, cwd=ROOT, env=env).returncode
    except Exception as exc:
        print(f"[deploy:{site_name}] ERROR: {exc}")
        return 1
    finally:
        if owned_temp_stage is not None and owned_temp_stage.exists():
            shutil.rmtree(owned_temp_stage, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
