(function () {
  if (window.__chatGptPerformanceBoosterLoaded) {
    return;
  }

  window.__chatGptPerformanceBoosterLoaded = true;

  const STORAGE_KEY = "cgpb-settings";
  const OVERLAY_ID = "cgpb-overlay";
  const MAX_CONVERSATION_CACHE = 5;
  const REFRESH_DELAY_MS = 80;
  const NAVIGATION_POLL_MS = 600;
  const DEFAULT_SETTINGS = {
    enabled: true,
    visibleCount: 12,
    loadBatchSize: 10,
    trimThreshold: 18,
    showStatusBadge: true,
    reduceEffects: true
  };
  const TURN_SELECTORS = [
    'main [data-message-author-role]',
    'main article[data-testid^="conversation-turn-"]',
    'main [data-testid^="conversation-turn-"]'
  ];

  let settings = { ...DEFAULT_SETTINGS };
  let observer = null;
  let refreshTimer = 0;
  let activeConversationKey = getConversationKey();
  let overlay = null;
  let overlayLessButton = null;
  let overlayLoadButton = null;
  let overlayRevealAllButton = null;
  const conversationStateCache = new Map();

  init();

  async function init() {
    settings = await readSettings();
    applyDocumentFlags();
    onDomReady(() => {
      ensureOverlay();
      observePage();
      installNavigationTracking();
      scheduleRefresh();
    });

    if (chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local" || !changes[STORAGE_KEY]) {
          return;
        }

        settings = normalizeSettings(changes[STORAGE_KEY].newValue || {});
        applyDocumentFlags();
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
      reduceEffects: raw.reduceEffects !== false
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

    activeConversationKey = nextKey;
    scheduleRefresh();
  }

  function observePage() {
    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver(() => {
      scheduleRefresh();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-message-author-role"]
    });
  }

  function scheduleRefresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refreshChat, REFRESH_DELAY_MS);
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

    updateOverlay({
      totalCount,
      targetVisibleCount,
      hiddenCount,
      manualBoost: conversationState.manualBoost,
      shouldTrim
    });
  }

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
