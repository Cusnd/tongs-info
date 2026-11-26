/* Tong's Information — Cross-Document View Transition Orchestrator
 * Loaded with `async blocking="render"` in <head> so `pagereveal` is always
 * registered before initial paint. Zero dependencies; bfcache-safe.
 */

(() => {
  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let cachedIssueOrder = null;

  function getIssueOrder() {
    if (cachedIssueOrder) return cachedIssueOrder;
    try {
      const raw = document.querySelector(".site-header")?.dataset.issueOrder;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          cachedIssueOrder = parsed;
          return cachedIssueOrder;
        }
      }
    } catch {
      /* ignore malformed metadata */
    }
    return {};
  }

  const INTENT_KEY = "ti:vt-intent";
  const SWAP_KEY = "ti:vt-swap-from";
  const SOURCE_MAP_KEY = "ti:vt-source-map";

  let lastClick = null;

  /** Parse a same-origin URL into normalized bilingual route metadata. */
  function parseRoute(urlLike) {
    let url;
    try {
      url = urlLike instanceof URL ? urlLike : new URL(String(urlLike), window.location.origin);
    } catch {
      return { kind: "other", basePath: "/", tabIndex: -1, slug: null, lang: "zh" };
    }

    let path = url.pathname.replace(/\/index\.html$/i, "/");
    if (!path.endsWith("/") && !path.includes(".")) path += "/";

    const isEn = path === "/en/" || path.startsWith("/en/");
    const lang = isEn ? "en" : "zh";
    let basePath = isEn ? path.slice(3) || "/" : path;
    if (!basePath.startsWith("/")) basePath = "/" + basePath;

    if (basePath === "/") return { kind: "cover", basePath, tabIndex: 0, slug: null, lang };
    if (basePath === "/archive/") return { kind: "archive", basePath, tabIndex: 1, slug: null, lang };
    if (basePath === "/stream/") return { kind: "stream", basePath, tabIndex: 2, slug: null, lang };
    if (basePath === "/graph/") return { kind: "graph", basePath, tabIndex: 3, slug: null, lang };
    if (basePath === "/about/") return { kind: "about", basePath, tabIndex: 4, slug: null, lang };

    const postMatch = basePath.match(/^\/posts\/([^/]+)\/$/);
    if (postMatch) {
      return { kind: "article", basePath, tabIndex: -1, slug: postMatch[1], lang };
    }

    return { kind: "other", basePath, tabIndex: -1, slug: null, lang };
  }

  function classifyTransition(fromRoute, toRoute) {
    if (fromRoute.basePath === toRoute.basePath) {
      return fromRoute.lang !== toRoute.lang ? "lang-switch" : "page-fade";
    }
    if (fromRoute.kind !== "article" && toRoute.kind === "article") {
      return "to-article";
    }
    if (fromRoute.kind === "article" && toRoute.kind !== "article") {
      return "from-article";
    }
    if (fromRoute.kind === "article" && toRoute.kind === "article") {
      if (fromRoute.slug === toRoute.slug) {
        return fromRoute.lang !== toRoute.lang ? "lang-switch" : "page-fade";
      }
      const issueOrder = getIssueOrder();
      const fromOrder = issueOrder[fromRoute.slug] ?? 0;
      const toOrder = issueOrder[toRoute.slug] ?? 0;
      if (fromOrder && toOrder && fromOrder !== toOrder) {
        return toOrder < fromOrder ? "article-next" : "article-prev";
      }
      return "article-switch";
    }
    if (fromRoute.tabIndex >= 0 && toRoute.tabIndex >= 0 && fromRoute.tabIndex !== toRoute.tabIndex) {
      return toRoute.tabIndex > fromRoute.tabIndex ? "nav-forward" : "nav-backward";
    }
    return "page-fade";
  }

  function isVisibleInViewport(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth
    );
  }

  /** Require meaningful overlap so a barely-peeking card corner never steals focus from a visible row. */
  function isMeaningfullyVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const overlapX = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
    const overlapY = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
    if (overlapX <= 0 || overlapY <= 0) return false;
    return overlapY >= Math.min(rect.height * 0.25, 24);
  }

  function routeKey(route) {
    return `${route.lang}:${route.basePath}`;
  }

  function saveSourceRole(fromRoute, slug, role) {
    if (!fromRoute || !slug || !role) return;
    try {
      const raw = sessionStorage.getItem(SOURCE_MAP_KEY);
      const map = raw ? JSON.parse(raw) : {};
      map[`${routeKey(fromRoute)}|${slug}`] = { role, ts: Date.now() };
      const entries = Object.entries(map)
        .sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0))
        .slice(0, 16);
      sessionStorage.setItem(SOURCE_MAP_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      /* ignore restricted storage */
    }
  }

  function readSourceRole(listingRoute, slug) {
    if (!listingRoute || !slug) return null;
    try {
      const raw = sessionStorage.getItem(SOURCE_MAP_KEY);
      if (!raw) return null;
      const map = JSON.parse(raw);
      const entry = map[`${routeKey(listingRoute)}|${slug}`];
      if (!entry || Date.now() - entry.ts > 30 * 60 * 1000) return null;
      return entry.role || null;
    } catch {
      return null;
    }
  }

  function detectClickSourceRole(anchor, destSlug) {
    if (!anchor) return "other";
    if (anchor.closest("#command-palette")) return "palette";
    const insideLink = anchor.closest(".cover-inside-list a[data-post-slug]");
    if (insideLink && (!destSlug || insideLink.dataset.postSlug === destSlug)) {
      return "inside-list";
    }
    const leadSheet = anchor.closest(".cover-sheet[data-lead-slug]");
    if (leadSheet && !anchor.closest(".cover-inside") && (!destSlug || leadSheet.dataset.leadSlug === destSlug)) {
      return "lead";
    }
    const archiveRow = anchor.closest(".dispatch-row[data-post-slug]");
    if (archiveRow && (!destSlug || archiveRow.dataset.postSlug === destSlug)) {
      return "archive-row";
    }
    const card = anchor.closest("[data-post-slug]");
    if (card && !card.matches("body, a") && (!destSlug || card.dataset.postSlug === destSlug)) {
      return "card";
    }
    return "other";
  }

  /** Track the exact clicked anchor without a fragile timeout so slow responses keep faithful morphs. */
  document.addEventListener(
    "click",
    (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const anchor = event.target?.closest?.("a[href]");
      if (!anchor || anchor.origin !== window.location.origin) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      const dest = parseRoute(anchor.href);
      const from = parseRoute(window.location.href);
      const sourceRole = detectClickSourceRole(anchor, dest.slug);

      lastClick = {
        anchor,
        href: anchor.href,
        from,
        dest,
        sourceRole,
        ts: Date.now(),
      };

      if (dest.kind === "article" && dest.slug && from.kind !== "article") {
        saveSourceRole(from, dest.slug, sourceRole);
      }

      try {
        sessionStorage.setItem(
          INTENT_KEY,
          JSON.stringify({
            fromUrl: window.location.href,
            fromPath: from.basePath,
            fromLang: from.lang,
            fromSlug: from.slug,
            toPath: dest.basePath,
            toLang: dest.lang,
            toSlug: dest.slug,
            sourceRole,
            ts: Date.now(),
          })
        );
      } catch {
        /* ignore restricted storage */
      }
    },
    true
  );

  function saveSwapState(fromRoute, toRoute, knownTo) {
    try {
      sessionStorage.setItem(
        SWAP_KEY,
        JSON.stringify({
          fromUrl: window.location.href,
          fromPath: fromRoute.basePath,
          fromLang: fromRoute.lang,
          fromSlug: fromRoute.slug,
          toPath: knownTo ? toRoute.basePath : null,
          toLang: knownTo ? toRoute.lang : null,
          toSlug: knownTo ? toRoute.slug : null,
          ts: Date.now(),
        })
      );
    } catch {
      /* ignore restricted storage */
    }
  }

  function readFromRouteFallback(toRoute) {
    try {
      const swapRaw = sessionStorage.getItem(SWAP_KEY);
      if (swapRaw) {
        sessionStorage.removeItem(SWAP_KEY);
        const swap = JSON.parse(swapRaw);
        if (swap && Date.now() - swap.ts <= 8000 && swap.fromUrl) {
          const targetMatches =
            swap.toPath === null || (swap.toPath === toRoute.basePath && swap.toLang === toRoute.lang);
          if (targetMatches) {
            return parseRoute(swap.fromUrl);
          }
        }
      }
    } catch {
      /* ignore restricted storage */
    }

    try {
      const raw = sessionStorage.getItem(INTENT_KEY);
      if (!raw) return null;
      sessionStorage.removeItem(INTENT_KEY);
      const parsed = JSON.parse(raw);
      if (!parsed || Date.now() - parsed.ts > 8000) return null;
      if (parsed.toPath !== toRoute.basePath || parsed.toLang !== toRoute.lang) return null;
      return parseRoute(parsed.fromUrl || (parsed.fromLang === "en" ? "/en" : "") + parsed.fromPath);
    } catch {
      return null;
    }
  }

  function matchInsideList(slug) {
    const insideLink = document.querySelector(`.cover-inside-list a[data-post-slug="${CSS.escape(slug)}"]`);
    if (!insideLink) return null;
    const label = insideLink.querySelector("span:not(.cover-inside-num)") || insideLink;
    if (!isMeaningfullyVisible(label)) return null;
    return { plate: null, plateHost: null, title: label, meta: null };
  }

  function matchLeadStory(slug) {
    const leadSheet = document.querySelector(`.cover-sheet[data-lead-slug="${CSS.escape(slug)}"]`);
    if (!leadSheet || !isVisibleInViewport(leadSheet)) return null;
    const stage = leadSheet.querySelector(".cover-stage");
    const fallbackImg = stage?.querySelector("img[data-cover-fallback]") || null;
    const plateVisible = stage ? isMeaningfullyVisible(stage) : false;
    const title = leadSheet.querySelector(".cover-story-title a");
    const meta = leadSheet.querySelector(".cover-lead-story > .meta-line");
    const visTitle = isMeaningfullyVisible(title) ? title : null;
    const visMeta = isMeaningfullyVisible(meta) ? meta : null;
    if (!plateVisible && !visTitle) return null;
    return {
      plate: plateVisible ? fallbackImg || stage : null,
      plateHost: plateVisible && fallbackImg && stage?.hasAttribute("data-cover-model") ? stage : null,
      title: visTitle,
      meta: visMeta,
    };
  }

  function matchCardOrRow(slug) {
    const containers = document.querySelectorAll(`[data-post-slug="${CSS.escape(slug)}"]`);
    let fallbackMatch = null;
    for (const container of containers) {
      if (container.matches("body") || container.matches("a")) continue;
      if (!isVisibleInViewport(container)) continue;
      const plate =
        container.querySelector(".editorial-plate img") || container.querySelector(".editorial-plate");
      const title = container.querySelector(".dispatch-title a, .plate-title-sm a, .cover-story-title a");
      const meta = container.querySelector(".meta-line");
      const visPlate = isMeaningfullyVisible(plate) ? plate : null;
      const visTitle = isMeaningfullyVisible(title) ? title : null;
      const visMeta = isMeaningfullyVisible(meta) ? meta : null;
      if (visTitle) {
        return { plate: visPlate, plateHost: null, title: visTitle, meta: visMeta };
      }
      if (visPlate && !fallbackMatch) {
        fallbackMatch = { plate: visPlate, plateHost: null, title: null, meta: visMeta };
      }
    }
    return fallbackMatch;
  }

  /** Find visible shared-element candidates for a given post slug on Cover or Archive. */
  function findListingElementsForSlug(slug, preferredRole) {
    if (!slug) return {};
    if (preferredRole === "palette") return {};
    if (document.querySelector("dialog[open]")) return {};

    if (preferredRole === "inside-list") {
      const res = matchInsideList(slug);
      if (res) return res;
    } else if (preferredRole === "lead") {
      const res = matchLeadStory(slug);
      if (res) return res;
    } else if (preferredRole === "card" || preferredRole === "archive-row") {
      const res = matchCardOrRow(slug);
      if (res) return res;
    }

    return matchCardOrRow(slug) || matchLeadStory(slug) || matchInsideList(slug) || {};
  }

  function findArticleHeroElements() {
    const plate =
      document.querySelector(".article-cover-plate img") ||
      document.querySelector(".article-cover-plate");
    const title = document.querySelector(".article-h1");
    const meta = document.querySelector(".article-hero .meta-line");
    return {
      plate: isMeaningfullyVisible(plate) ? plate : null,
      plateHost: null,
      title: isMeaningfullyVisible(title) ? title : null,
      meta: isMeaningfullyVisible(meta) ? meta : null,
    };
  }

  const temporaryElements = new Set();
  const temporaryHandoffHosts = new Set();
  const assignedNames = new Set();

  function assignTempName(el, name) {
    if (!el || !name || assignedNames.has(name)) return;
    el.style.viewTransitionName = name;
    temporaryElements.add(el);
    assignedNames.add(name);
  }

  function enablePlateHandoff(hostEl) {
    if (!hostEl) return;
    hostEl.setAttribute("data-vt-plate-handoff", "true");
    temporaryHandoffHosts.add(hostEl);
  }

  function cleanupTempNames() {
    for (const el of temporaryElements) {
      el.style.viewTransitionName = "";
    }
    temporaryElements.clear();
    assignedNames.clear();

    for (const host of temporaryHandoffHosts) {
      host.removeAttribute("data-vt-plate-handoff");
    }
    temporaryHandoffHosts.clear();

    document.documentElement.removeAttribute("data-vt-header-offscreen");
    document.documentElement.removeAttribute("data-vt-masthead-offscreen");
  }

  function syncViewportGuards() {
    const header = document.querySelector(".site-header");
    if (header && !isVisibleInViewport(header)) {
      document.documentElement.setAttribute("data-vt-header-offscreen", "");
    } else {
      document.documentElement.removeAttribute("data-vt-header-offscreen");
    }

    const coverMasthead = document.querySelector("body.is-cover .cover-masthead");
    if (coverMasthead && !isVisibleInViewport(coverMasthead)) {
      document.documentElement.setAttribute("data-vt-masthead-offscreen", "");
    } else {
      document.documentElement.removeAttribute("data-vt-masthead-offscreen");
    }
  }

  function bindCleanup(viewTransition, isReveal = false) {
    if (!viewTransition) return;
    if (isReveal) {
      window.__tiRevealTransition = viewTransition;
    }
    /* Synchronously attach rejection handlers to every ViewTransition promise
       so skipped/interrupted transitions never trigger unhandled AbortErrors. */
    viewTransition.updateCallbackDone?.catch?.(() => {});
    viewTransition.ready?.catch?.(() => {});
    viewTransition.finished
      ?.catch?.(() => {})
      .finally(() => {
        if (isReveal && window.__tiRevealTransition === viewTransition) {
          window.__tiRevealTransition = null;
        }
        cleanupTempNames();
      });
  }

  /* Outgoing document snapshot preparation */
  window.addEventListener("pageswap", (event) => {
    const fromRoute = parseRoute(event.activation?.from?.url || window.location.href);
    const hasActivationTo = Boolean(event.activation?.entry?.url);
    const clickMatchesTarget =
      lastClick &&
      (!hasActivationTo ||
        (parseRoute(event.activation.entry.url).basePath === lastClick.dest.basePath &&
          parseRoute(event.activation.entry.url).lang === lastClick.dest.lang));

    const toUrl = event.activation?.entry?.url || (clickMatchesTarget ? lastClick.href : null);
    const knownTo = Boolean(toUrl);
    const toRoute = knownTo ? parseRoute(toUrl) : fromRoute;

    /* Always persist outgoing route so pagereveal can classify Back/Forward even without Navigation API */
    saveSwapState(fromRoute, toRoute, knownTo);

    /* Close command palette cleanly before snapshot when navigating via a palette result */
    if (clickMatchesTarget && lastClick.sourceRole === "palette") {
      const palette = document.getElementById("command-palette");
      if (palette?.open) {
        palette.removeAttribute("data-closing");
        palette.close();
      }
    }

    if (!event.viewTransition || reducedMotionQuery.matches) return;
    cleanupTempNames();
    syncViewportGuards();

    if (knownTo) {
      const type = classifyTransition(fromRoute, toRoute);
      event.viewTransition.types?.add?.(type);

      if (type === "to-article" && toRoute.slug) {
        const preferredRole = clickMatchesTarget
          ? lastClick.sourceRole
          : readSourceRole(fromRoute, toRoute.slug);
        if (preferredRole) {
          saveSourceRole(fromRoute, toRoute.slug, preferredRole);
        }
        const targets = findListingElementsForSlug(toRoute.slug, preferredRole);
        if (targets.plateHost) enablePlateHandoff(targets.plateHost);
        assignTempName(targets.plate, "article-plate");
        assignTempName(targets.title, "article-title");
        assignTempName(targets.meta, "article-meta");
      } else if (type === "from-article" && fromRoute.slug) {
        const hero = findArticleHeroElements();
        assignTempName(hero.plate, "article-plate");
        assignTempName(hero.title, "article-title");
        assignTempName(hero.meta, "article-meta");
      }
    }

    bindCleanup(event.viewTransition, false);
  });

  /* Incoming document snapshot reveal */
  window.addEventListener("pagereveal", (event) => {
    if (!event.viewTransition) {
      window.__tiRevealTransition = null;
      cleanupTempNames();
      return;
    }
    if (reducedMotionQuery.matches) {
      event.viewTransition.skipTransition?.();
      window.__tiRevealTransition = null;
      cleanupTempNames();
      return;
    }

    cleanupTempNames();
    syncViewportGuards();

    const activation = window.navigation?.activation;
    const toRoute = parseRoute(activation?.entry?.url || window.location.href);
    const fromRoute = activation?.from?.url
      ? parseRoute(activation.from.url)
      : readFromRouteFallback(toRoute);

    if (fromRoute) {
      const type = classifyTransition(fromRoute, toRoute);
      event.viewTransition.types?.add?.(type);

      if (type === "to-article" && toRoute.slug) {
        const hero = findArticleHeroElements();
        assignTempName(hero.plate, "article-plate");
        assignTempName(hero.title, "article-title");
        assignTempName(hero.meta, "article-meta");
      } else if (type === "from-article" && fromRoute.slug) {
        const savedRole = readSourceRole(toRoute, fromRoute.slug);
        const targets = findListingElementsForSlug(fromRoute.slug, savedRole);
        if (targets.plateHost) enablePlateHandoff(targets.plateHost);
        assignTempName(targets.plate, "article-plate");
        assignTempName(targets.title, "article-title");
        assignTempName(targets.meta, "article-meta");
      }
    }

    bindCleanup(event.viewTransition, true);
  });

  /* Ensure bfcache restores never inherit stale transition names or stuck modal state */
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      lastClick = null;
      window.__tiRevealTransition = null;
      cleanupTempNames();
    }
  });
})();
