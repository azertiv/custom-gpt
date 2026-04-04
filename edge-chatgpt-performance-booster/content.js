(function () {
  if (window.__chatGptPerformanceBoosterLoaded) {
    return;
  }

  window.__chatGptPerformanceBoosterLoaded = true;

  const STORAGE_KEY = "cgpb-settings";
  const OVERLAY_ID = "cgpb-overlay";
  const MAX_CONVERSATION_CACHE = 5;
  const NAVIGATION_POLL_MS = 600;
  const LAZY_PLACEHOLDER_CLASS = "cgpb-lazy-placeholder";
  const LAZY_HIDDEN_ATTR = "data-cgpb-lazy-hidden";
  const DEFAULT_SETTINGS = {
    enabled: true,
    visibleCount: 12,
    loadBatchSize: 10,
    trimThreshold: 18,
    showStatusBadge: true,
    reduceEffects: true,
    cleanupOnSwitch: false,
    lazyRenderMedia: true,
    lazyRenderMargin: 300,
    observerThrottleMs: 80,
    scrollDebounceMs: 100
  };
  const TURN_SELECTORS = [
    'main [data-message-author-role]',
    'main article[data-testid^="conversation-turn-"]',
    'main [data-testid^="conversation-turn-"]'
  ];

  let settings = { ...DEFAULT_SETTINGS };
  let observer = null;
  let refreshTimer = 0;
  let refreshRafId = 0;
  let activeConversationKey = getConversationKey();
  let overlay = null;
  let overlayLessButton = null;
  let overlayLoadButton = null;
  let overlayRevealAllButton = null;
  let lazyObserver = null;
  let pendingMutations = false;
  const conversationStateCache = new Map();

  init();

  async function init() {
    settings = await readSettings();
    applyDocumentFlags();
    onDomReady(() => {
      ensureOverlay();
      observePage();
      installNavigationTracking();
      initLazyRendering();
      scheduleRefresh();
    });

    if (chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local" || !changes[STORAGE_KEY]) {
          return;
        }

        const prev = settings;
        settings = normalizeSettings(changes[STORAGE_KEY].newValue || {});
        applyDocumentFlags();

        if (prev.lazyRenderMedia !== settings.lazyRenderMedia ||
            prev.lazyRenderMargin !== settings.lazyRenderMargin) {
          destroyLazyRendering();
          initLazyRendering();
        }

        scheduleRefresh();
      });
    }
  }

  function onDomReady(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
      return;
    }

    callback();
  }

  function normalizeSettings(raw) {
    return {
      enabled: raw.enabled !== false,
      visibleCount: clampInteger(raw.visibleCount, 3, 80, DEFAULT_SETTINGS.visibleCount),
      loadBatchSize: clampInteger(raw.loadBatchSize, 1, 40, DEFAULT_SETTINGS.loadBatchSize),
      trimThreshold: clampInteger(raw.trimThreshold, 6, 200, DEFAULT_SETTINGS.trimThreshold),
      showStatusBadge: raw.showStatusBadge !== false,
      reduceEffects: raw.reduceEffects !== false,
      cleanupOnSwitch: raw.cleanupOnSwitch === true,
      lazyRenderMedia: raw.lazyRenderMedia !== false,
      lazyRenderMargin: clampInteger(raw.lazyRenderMargin, 0, 1000, DEFAULT_SETTINGS.lazyRenderMargin),
      observerThrottleMs: clampInteger(raw.observerThrottleMs, 16, 500, DEFAULT_SETTINGS.observerThrottleMs),
      scrollDebounceMs: clampInteger(raw.scrollDebounceMs, 16, 500, DEFAULT_SETTINGS.scrollDebounceMs)
    };
  }

  function clampInteger(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, parsed));
  }

  async function readSettings() {
    if (!chrome.storage?.local) {
      return { ...DEFAULT_SETTINGS };
    }

    const result = await chrome.storage.local.get(STORAGE_KEY);
    return normalizeSettings(result[STORAGE_KEY] || {});
  }

  function getConversationKey() {
    const cleanPath = location.pathname.replace(/\/+$/, "") || "/";
    return `${location.origin}${cleanPath}`;
  }

  function getConversationState() {
    const existing = conversationStateCache.get(activeConversationKey);
    if (existing) {
      conversationStateCache.delete(activeConversationKey);
      conversationStateCache.set(activeConversationKey, existing);
      return existing;
    }

    const created = { manualBoost: 0 };
    conversationStateCache.set(activeConversationKey, created);

    while (conversationStateCache.size > MAX_CONVERSATION_CACHE) {
      const oldestKey = conversationStateCache.keys().next().value;
      conversationStateCache.delete(oldestKey);
    }

    return created;
  }

  function applyDocumentFlags() {
    const root = document.documentElement;
    if (!root) {
      return;
    }

    root.setAttribute("data-cgpb-extension", "true");
    root.setAttribute("data-cgpb-enabled", settings.enabled ? "true" : "false");
    root.setAttribute("data-cgpb-reduce-effects", settings.enabled && settings.reduceEffects ? "true" : "false");
  }

  /* ───────────────────────────────────────────────────
     Navigation tracking + memory cleanup
     ─────────────────────────────────────────────────── */

  function installNavigationTracking() {
    if (window.__cgpbNavigationInstalled) {
      return;
    }

    window.__cgpbNavigationInstalled = true;

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function pushStateWrapper() {
      const result = originalPushState.apply(this, arguments);
      handleNavigationChange();
      return result;
    };

    history.replaceState = function replaceStateWrapper() {
      const result = originalReplaceState.apply(this, arguments);
      handleNavigationChange();
      return result;
    };

    window.addEventListener("popstate", handleNavigationChange);
    window.setInterval(handleNavigationChange, NAVIGATION_POLL_MS);
  }

  function handleNavigationChange() {
    const nextKey = getConversationKey();
    if (nextKey === activeConversationKey) {
      return;
    }

    const previousKey = activeConversationKey;
    activeConversationKey = nextKey;

    // Feature 1: Memory cleanup — force full page reload on conversation switch
    if (settings.cleanupOnSwitch && previousKey !== "/" && nextKey !== previousKey) {
      window.location.reload();
      return;
    }

    scheduleRefresh();
  }

  /* ───────────────────────────────────────────────────
     MutationObserver with rAF-throttled callback
     ─────────────────────────────────────────────────── */

  function observePage() {
    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver(() => {
      // Feature 3: rAF-throttle — batch mutations into a single rAF frame
      // instead of firing scheduleRefresh on every single mutation.
      if (pendingMutations) {
        return;
      }

      pendingMutations = true;
      window.requestAnimationFrame(() => {
        pendingMutations = false;
        scheduleRefresh();
      });
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-message-author-role"]
    });
  }

  /* ───────────────────────────────────────────────────
     Debounced refresh with configurable delay
     ─────────────────────────────────────────────────── */

  function scheduleRefresh() {
    window.clearTimeout(refreshTimer);
    window.cancelAnimationFrame(refreshRafId);

    // Feature 3: configurable debounce — the timer waits observerThrottleMs,
    // then fires refreshChat inside a rAF so layout reads are batched.
    refreshTimer = window.setTimeout(() => {
      refreshRafId = window.requestAnimationFrame(refreshChat);
    }, settings.observerThrottleMs);
  }

  function refreshChat() {
    applyDocumentFlags();
    ensureOverlay();

    const turns = getTurnContainers();
    const totalCount = turns.length;
    const conversationState = getConversationState();
    const shouldTrim = settings.enabled && totalCount >= settings.trimThreshold;
    const targetVisibleCount = shouldTrim
      ? Math.min(totalCount, settings.visibleCount + conversationState.manualBoost)
      : totalCount;
    const hiddenCount = Math.max(0, totalCount - targetVisibleCount);
    const scrollContainer = getScrollContainer(turns);
    const scrollSnapshot = captureScrollSnapshot(scrollContainer);
    let hasVisualChange = false;

    turns.forEach((turn, index) => {
      const hideTurn = shouldTrim && index < hiddenCount;
      const nextDisplay = hideTurn ? "none" : "";
      if (turn.dataset.cgpbHidden !== (hideTurn ? "true" : "false") || turn.style.display !== nextDisplay) {
        hasVisualChange = true;
      }
      turn.classList.add("cgpb-managed-turn");
      turn.dataset.cgpbHidden = hideTurn ? "true" : "false";
      turn.style.display = nextDisplay;
    });

    if (hasVisualChange) {
      restoreScrollSnapshot(scrollContainer, scrollSnapshot);
    }

    // Feature 2: scan visible turns for new heavy elements to lazy-observe
    if (settings.enabled && settings.lazyRenderMedia && lazyObserver) {
      scanForLazyTargets(turns);
    }

    updateOverlay({
      totalCount,
      targetVisibleCount,
      hiddenCount,
      manualBoost: conversationState.manualBoost,
      shouldTrim
    });
  }

  /* ───────────────────────────────────────────────────
     Turn detection helpers
     ─────────────────────────────────────────────────── */

  function getTurnContainers() {
    const seen = new Set();
    const turns = [];

    TURN_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        if (!(node instanceof HTMLElement)) {
          return;
        }

        const turn = normalizeTurnNode(node);
        if (!turn || seen.has(turn)) {
          return;
        }

        if (!turn.closest("main")) {
          return;
        }

        if (turn.closest(`#${OVERLAY_ID}`) || turn.closest("nav") || turn.closest("form")) {
          return;
        }

        if (!hasRenderableContent(turn)) {
          return;
        }

        seen.add(turn);
        turns.push(turn);
      });
    });

    turns.sort((left, right) => {
      const position = left.compareDocumentPosition(right);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
        return -1;
      }
      if (position & Node.DOCUMENT_POSITION_PRECEDING) {
        return 1;
      }
      return 0;
    });

    return turns;
  }

  function normalizeTurnNode(node) {
    const articleAncestor = node.closest('article[data-testid^="conversation-turn-"], article');
    if (articleAncestor instanceof HTMLElement) {
      return articleAncestor;
    }

    if (node.matches('[data-message-author-role]')) {
      return node;
    }

    const roleAncestor = node.closest('[data-message-author-role]');
    if (roleAncestor instanceof HTMLElement) {
      return roleAncestor;
    }

    if (node.matches("article")) {
      return node;
    }

    return null;
  }

  function hasRenderableContent(turn) {
    const text = (turn.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length > 0) {
      return true;
    }

    return Boolean(turn.querySelector("img, video, canvas, svg, pre, table, code"));
  }

  /* ───────────────────────────────────────────────────
     Feature 2: Lazy rendering of code blocks & images
     ─────────────────────────────────────────────────── */

  function initLazyRendering() {
    if (!settings.enabled || !settings.lazyRenderMedia) {
      return;
    }

    if (lazyObserver) {
      return;
    }

    lazyObserver = new IntersectionObserver(handleLazyIntersections, {
      rootMargin: `${settings.lazyRenderMargin}px 0px`,
      threshold: 0
    });
  }

  function destroyLazyRendering() {
    if (!lazyObserver) {
      return;
    }

    // Restore all currently-hidden elements before tearing down
    document.querySelectorAll(`[${LAZY_HIDDEN_ATTR}]`).forEach((element) => {
      showLazyElement(element);
    });

    document.querySelectorAll(`.${LAZY_PLACEHOLDER_CLASS}`).forEach((ph) => ph.remove());

    lazyObserver.disconnect();
    lazyObserver = null;
  }

  function scanForLazyTargets(turns) {
    turns.forEach((turn) => {
      if (turn.dataset.cgpbHidden === "true") {
        return;
      }

      // Target heavy elements: code blocks and images/videos
      turn.querySelectorAll("pre, img, video").forEach((el) => {
        if (!(el instanceof HTMLElement)) {
          return;
        }

        // Skip if already managed or if inside overlay
        if (el.hasAttribute(LAZY_HIDDEN_ATTR) || el.dataset.cgpbLazyObserved) {
          return;
        }

        // Skip small images (icons, avatars)
        if (el.tagName === "IMG" && el.offsetHeight < 40 && el.offsetWidth < 40) {
          return;
        }

        el.dataset.cgpbLazyObserved = "true";
        lazyObserver.observe(el);
      });
    });
  }

  function handleLazyIntersections(entries) {
    entries.forEach((entry) => {
      const el = entry.target;

      if (entry.isIntersecting) {
        // Element entering viewport+margin — restore it
        if (el.hasAttribute(LAZY_HIDDEN_ATTR)) {
          showLazyElement(el);
        }
      } else {
        // Element leaving viewport+margin — replace with placeholder
        if (!el.hasAttribute(LAZY_HIDDEN_ATTR) && el.offsetHeight > 0) {
          hideLazyElement(el);
        }
      }
    });
  }

  function hideLazyElement(el) {
    const rect = el.getBoundingClientRect();
    const height = rect.height || el.offsetHeight || 80;

    // Create lightweight placeholder
    const placeholder = document.createElement("div");
    placeholder.className = LAZY_PLACEHOLDER_CLASS;
    placeholder.style.height = `${height}px`;
    placeholder.style.minHeight = `${height}px`;
    placeholder.dataset.cgpbPlaceholderFor = el.dataset.cgpbLazyObserved || "1";

    // Insert placeholder before element, then hide element
    el.parentNode.insertBefore(placeholder, el);
    el.setAttribute(LAZY_HIDDEN_ATTR, "true");
    el.style.display = "none";

    // Observe the placeholder so we know when to restore
    lazyObserver.observe(placeholder);
  }

  function showLazyElement(el) {
    el.removeAttribute(LAZY_HIDDEN_ATTR);
    el.style.display = "";

    // Remove the placeholder that sits before this element
    const prev = el.previousElementSibling;
    if (prev && prev.classList.contains(LAZY_PLACEHOLDER_CLASS)) {
      lazyObserver.unobserve(prev);
      prev.remove();
    }
  }

  /* ───────────────────────────────────────────────────
     Scroll & layout helpers
     ─────────────────────────────────────────────────── */

  function getScrollContainer(turns) {
    const anchor = turns[0] || document.querySelector("main");
    if (anchor instanceof HTMLElement) {
      let current = anchor;
      while (current && current !== document.body) {
        const style = window.getComputedStyle(current);
        if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight + 40) {
          return current;
        }
        current = current.parentElement;
      }
    }

    return document.scrollingElement || document.documentElement;
  }

  function captureScrollSnapshot(container) {
    const isDocument = container === document.scrollingElement || container === document.documentElement || container === document.body;
    const scrollTop = isDocument ? window.scrollY : container.scrollTop;
    const viewportHeight = isDocument ? window.innerHeight : container.clientHeight;
    const scrollHeight = isDocument ? document.documentElement.scrollHeight : container.scrollHeight;

    return {
      isDocument,
      scrollTop,
      viewportHeight,
      scrollHeight,
      distanceFromBottom: scrollHeight - scrollTop - viewportHeight
    };
  }

  function restoreScrollSnapshot(container, snapshot) {
    if (!snapshot) {
      return;
    }

    const isNearBottom = snapshot.distanceFromBottom < 140;
    const newScrollHeight = snapshot.isDocument ? document.documentElement.scrollHeight : container.scrollHeight;
    const nextTop = Math.max(0, newScrollHeight - snapshot.viewportHeight - snapshot.distanceFromBottom);

    if (snapshot.isDocument) {
      window.scrollTo({
        top: isNearBottom ? document.documentElement.scrollHeight : nextTop,
        behavior: "auto"
      });
      return;
    }

    container.scrollTop = isNearBottom ? container.scrollHeight : nextTop;
  }

  /* ───────────────────────────────────────────────────
     Overlay panel
     ─────────────────────────────────────────────────── */

  function ensureOverlay() {
    if (overlay?.isConnected) {
      return;
    }

    overlay = document.createElement("aside");
    overlay.id = OVERLAY_ID;
    overlay.innerHTML = [
      '<div class="cgpb-panel">',
      '  <div class="cgpb-actions">',
      '    <button type="button" id="cgpb-less">-</button>',
      '    <button type="button" id="cgpb-load-more">+</button>',
      '    <button type="button" id="cgpb-reveal-all">All</button>',
      "  </div>",
      "</div>"
    ].join("");

    overlayLessButton = overlay.querySelector("#cgpb-less");
    overlayLoadButton = overlay.querySelector("#cgpb-load-more");
    overlayRevealAllButton = overlay.querySelector("#cgpb-reveal-all");

    overlayLessButton?.addEventListener("click", () => {
      const state = getConversationState();
      state.manualBoost = Math.max(0, state.manualBoost - settings.loadBatchSize);
      scheduleRefresh();
    });

    overlayLoadButton?.addEventListener("click", () => {
      const state = getConversationState();
      state.manualBoost += settings.loadBatchSize;
      scheduleRefresh();
    });

    overlayRevealAllButton?.addEventListener("click", () => {
      const turns = getTurnContainers();
      const state = getConversationState();
      state.manualBoost = Math.max(0, turns.length - settings.visibleCount);
      scheduleRefresh();
    });

    document.documentElement.appendChild(overlay);
  }

  function updateOverlay({ totalCount, targetVisibleCount, hiddenCount, manualBoost, shouldTrim }) {
    if (!overlay) {
      return;
    }

    const shouldShowOverlay = settings.enabled && settings.showStatusBadge && totalCount > 0;
    overlay.hidden = !shouldShowOverlay;

    if (!shouldShowOverlay) {
      return;
    }

    if (overlayLessButton) {
      overlayLessButton.disabled = manualBoost <= 0;
    }

    if (overlayLoadButton) {
      overlayLoadButton.disabled = hiddenCount <= 0;
    }

    if (overlayRevealAllButton) {
      overlayRevealAllButton.disabled = !(shouldTrim && targetVisibleCount < totalCount);
    }
  }
})();
