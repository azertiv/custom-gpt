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
  const LONG_REPLY_HEIGHT_PX = 460;
  const LONG_REPLY_TEXT_LENGTH = 1600;
  const PDF_PAGE_WIDTH = 595.28;
  const PDF_PAGE_HEIGHT = 841.89;
  const PDF_MARGIN = 48;
  const PDF_FONT_SIZE = 11;
  const PDF_LINE_HEIGHT = 15;
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
  let navigationTimer = 0;
  let activeConversationKey = getConversationKey();
  let overlay = null;
  let overlaySummary = null;
  let overlayMode = null;
  let overlayLoadButton = null;
  let overlayResetButton = null;
  let overlayRevealAllButton = null;
  let overlayNoticeTimer = 0;
  const conversationStateCache = new Map();
  const activeExports = new Set();

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

    const created = {
      manualBoost: 0,
      expandedReplies: Object.create(null)
    };
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
    navigationTimer = window.setInterval(handleNavigationChange, NAVIGATION_POLL_MS);
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

    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "childList" && (mutation.addedNodes.length || mutation.removedNodes.length)) {
          scheduleRefresh();
          return;
        }

        if (mutation.type === "attributes") {
          scheduleRefresh();
          return;
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-message-author-role", "class", "href"]
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
      turn.dataset.cgpbManaged = "true";
      turn.dataset.cgpbHidden = hideTurn ? "true" : "false";
      turn.style.display = nextDisplay;
    });

    if (hasVisualChange) {
      restoreScrollSnapshot(scrollContainer, scrollSnapshot);
    }

    const collapsedCount = applyLongReplyControls(turns, conversationState);
    updateSidebarExportButtons();

    updateOverlay({
      totalCount,
      targetVisibleCount,
      hiddenCount,
      manualBoost: conversationState.manualBoost,
      shouldTrim,
      collapsedCount
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

    const articleAncestor = node.closest("article");
    return articleAncestor instanceof HTMLElement ? articleAncestor : null;
  }

  function hasRenderableContent(turn) {
    const text = (turn.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length > 0) {
      return true;
    }

    return Boolean(turn.querySelector("img, video, canvas, svg, pre, table, code"));
  }

  function getTurnRole(turn) {
    const ownRole = turn.getAttribute("data-message-author-role");
    if (ownRole) {
      return ownRole;
    }

    const roleNode = turn.querySelector("[data-message-author-role]");
    return roleNode?.getAttribute("data-message-author-role") || "";
  }

  function getTurnContentElement(turn) {
    return (
      turn.querySelector(".markdown") ||
      turn.querySelector('[class*="markdown"]') ||
      turn.querySelector('[class*="prose"]') ||
      turn.querySelector(".whitespace-pre-wrap") ||
      turn
    );
  }

  function getTurnKey(turn, index) {
    const directId =
      turn.getAttribute("data-message-id") ||
      turn.getAttribute("data-testid") ||
      turn.id;

    if (directId) {
      return directId;
    }

    const text = ((turn.textContent || "").trim().slice(0, 80) || `turn-${index}`).replace(/\s+/g, "-");
    return `${getConversationKey()}::${index}::${text}`;
  }

  function applyLongReplyControls(turns, conversationState) {
    let collapsedCount = 0;

    turns.forEach((turn, index) => {
      const role = getTurnRole(turn);
      if (role !== "assistant") {
        cleanupLongReplyControl(turn);
        return;
      }

      const content = getTurnContentElement(turn);
      if (!(content instanceof HTMLElement)) {
        cleanupLongReplyControl(turn);
        return;
      }

      const textLength = (content.innerText || content.textContent || "").trim().length;
      const isLong =
        content.scrollHeight > LONG_REPLY_HEIGHT_PX ||
        textLength > LONG_REPLY_TEXT_LENGTH ||
        content.querySelectorAll("pre, table, ul, ol, blockquote").length >= 3;

      if (!isLong) {
        cleanupLongReplyControl(turn);
        return;
      }

      const key = getTurnKey(turn, index);
      const isExpanded = conversationState.expandedReplies[key] === true;
      const button = ensureLongReplyButton(turn, key);

      turn.classList.add("cgpb-collapsible-turn");
      content.classList.add("cgpb-long-reply-target");
      content.dataset.cgpbCollapseKey = key;
      turn.dataset.cgpbCollapseKey = key;
      turn.dataset.cgpbCollapsed = isExpanded ? "false" : "true";
      button.textContent = isExpanded ? "Replier" : "Déplier";
      button.setAttribute("aria-expanded", isExpanded ? "true" : "false");

      if (!isExpanded) {
        collapsedCount += 1;
      }
    });

    return collapsedCount;
  }

  function ensureLongReplyButton(turn, key) {
    let button = turn.querySelector(":scope > .cgpb-long-reply-toggle");
    if (button instanceof HTMLButtonElement) {
      button.dataset.cgpbCollapseKey = key;
      return button;
    }

    button = document.createElement("button");
    button.type = "button";
    button.className = "cgpb-long-reply-toggle";
    button.dataset.cgpbCollapseKey = key;
    button.addEventListener("click", () => {
      const state = getConversationState();
      const collapseKey = button.dataset.cgpbCollapseKey;
      state.expandedReplies[collapseKey] = !(state.expandedReplies[collapseKey] === true);
      scheduleRefresh();
    });
    turn.appendChild(button);
    return button;
  }

  function cleanupLongReplyControl(turn) {
    turn.classList.remove("cgpb-collapsible-turn");
    turn.removeAttribute("data-cgpb-collapsed");
    turn.removeAttribute("data-cgpb-collapse-key");

    const button = turn.querySelector(":scope > .cgpb-long-reply-toggle");
    if (button) {
      button.remove();
    }

    turn.querySelectorAll(".cgpb-long-reply-target").forEach((node) => {
      node.classList.remove("cgpb-long-reply-target");
      node.removeAttribute("data-cgpb-collapse-key");
    });
  }

  function getScrollContainer(turns) {
    const anchor = turns[0] || document.querySelector("main");
    if (anchor instanceof HTMLElement) {
      let current = anchor;
      while (current && current !== document.body) {
        const style = window.getComputedStyle(current);
        const scrollable = /(auto|scroll)/.test(style.overflowY);
        if (scrollable && current.scrollHeight > current.clientHeight + 40) {
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
      '  <div class="cgpb-header">',
      '    <div>',
      '      <p class="cgpb-eyebrow">Performance Booster</p>',
      '      <h2 class="cgpb-title">ChatGPT optimise localement le rendu</h2>',
      "    </div>",
      '    <span class="cgpb-mode" id="cgpb-mode">Actif</span>',
      "  </div>",
      '  <p class="cgpb-summary" id="cgpb-summary"></p>',
      '  <div class="cgpb-actions">',
      '    <button type="button" id="cgpb-load-more">Afficher plus</button>',
      '    <button type="button" id="cgpb-reset-window" class="cgpb-secondary">Mode rapide</button>',
      '    <button type="button" id="cgpb-reveal-all" class="cgpb-secondary">Tout afficher</button>',
      "  </div>",
      "</div>"
    ].join("");

    overlaySummary = overlay.querySelector("#cgpb-summary");
    overlayMode = overlay.querySelector("#cgpb-mode");
    overlayLoadButton = overlay.querySelector("#cgpb-load-more");
    overlayResetButton = overlay.querySelector("#cgpb-reset-window");
    overlayRevealAllButton = overlay.querySelector("#cgpb-reveal-all");

    overlayLoadButton?.addEventListener("click", () => {
      const state = getConversationState();
      state.manualBoost += settings.loadBatchSize;
      scheduleRefresh();
    });

    overlayResetButton?.addEventListener("click", () => {
      const state = getConversationState();
      state.manualBoost = 0;
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

  function updateOverlay({ totalCount, targetVisibleCount, hiddenCount, manualBoost, shouldTrim, collapsedCount }) {
    if (!overlay || !overlaySummary || !overlayMode) {
      return;
    }

    const shouldShowOverlay = settings.enabled && settings.showStatusBadge && totalCount > 0;
    overlay.hidden = !shouldShowOverlay;

    if (!shouldShowOverlay) {
      return;
    }

    overlayMode.textContent = settings.reduceEffects ? "Actif + effets reduits" : "Actif";

    if (!shouldTrim) {
      overlaySummary.textContent =
        collapsedCount > 0
          ? `Conversation courte. ${collapsedCount} longue${collapsedCount > 1 ? "s" : ""} reponse${collapsedCount > 1 ? "s" : ""} repliee${collapsedCount > 1 ? "s" : ""}.`
          : "Conversation courte: aucun message masque pour l'instant.";
      toggleActionButtons({
        loadMore: false,
        reset: manualBoost > 0,
        revealAll: false
      });
      return;
    }

    const collapsedText =
      collapsedCount > 0 ? ` ${collapsedCount} longue${collapsedCount > 1 ? "s" : ""} reponse${collapsedCount > 1 ? "s" : ""} sont repliee${collapsedCount > 1 ? "s" : ""}.` : "";

    overlaySummary.textContent = `${targetVisibleCount} messages visibles sur ${totalCount}. ${hiddenCount} messages plus anciens sont masques pour alleger le DOM.${collapsedText}`;
    toggleActionButtons({
      loadMore: hiddenCount > 0,
      reset: manualBoost > 0,
      revealAll: hiddenCount > 0
    });
  }

  function toggleActionButtons({ loadMore, reset, revealAll }) {
    if (overlayLoadButton) {
      overlayLoadButton.hidden = !loadMore;
      overlayLoadButton.textContent = `Afficher ${settings.loadBatchSize} de plus`;
    }

    if (overlayResetButton) {
      overlayResetButton.hidden = !reset;
    }

    if (overlayRevealAllButton) {
      overlayRevealAllButton.hidden = !revealAll;
    }
  }

  function updateSidebarExportButtons() {
    document.querySelectorAll('a[href*="/c/"]').forEach((link) => {
      if (!(link instanceof HTMLAnchorElement)) {
        return;
      }

      const conversationId = extractConversationId(link.href);
      if (!conversationId) {
        return;
      }

      const host = link.closest('[data-sidebar-item="true"]') || link.parentElement;
      if (!(host instanceof HTMLElement)) {
        return;
      }

      host.classList.add("cgpb-sidebar-export-host");

      let button = host.querySelector(":scope > .cgpb-export-button");
      if (!(button instanceof HTMLButtonElement)) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "cgpb-export-button";
        button.innerHTML = [
          '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">',
          '  <path d="M8 2v7"></path>',
          '  <path d="M5 7.5 8 10.5 11 7.5"></path>',
          '  <path d="M3 12.5h10"></path>',
          "</svg>"
        ].join("");
        button.setAttribute("aria-label", "Telecharger la discussion en PDF");
        button.title = "Telecharger la discussion en PDF";
        button.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();

          const targetButton = event.currentTarget;
          if (!(targetButton instanceof HTMLButtonElement)) {
            return;
          }

          const targetConversationId = targetButton.dataset.cgpbConversationId;
          const targetTitle = targetButton.dataset.cgpbConversationTitle || "discussion-chatgpt";
          await exportConversationPdf(targetConversationId, targetTitle, targetButton);
        });
        host.appendChild(button);
      }

      button.dataset.cgpbConversationId = conversationId;
      button.dataset.cgpbConversationTitle = (link.textContent || "discussion-chatgpt").trim();
      button.disabled = activeExports.has(conversationId);
      button.setAttribute("data-cgpb-loading", activeExports.has(conversationId) ? "true" : "false");
    });
  }

  function extractConversationId(url) {
    try {
      const parsed = new URL(url, location.origin);
      const match = parsed.pathname.match(/\/c\/([a-zA-Z0-9-]+)/);
      return match ? match[1] : "";
    } catch (_error) {
      const match = String(url).match(/\/c\/([a-zA-Z0-9-]+)/);
      return match ? match[1] : "";
    }
  }

  async function exportConversationPdf(conversationId, fallbackTitle, button) {
    if (!conversationId || activeExports.has(conversationId)) {
      return;
    }

    activeExports.add(conversationId);
    if (button) {
      button.disabled = true;
      button.setAttribute("data-cgpb-loading", "true");
    }

    try {
      const conversation = await loadConversationForExport(conversationId, fallbackTitle);
      const pdfBytes = buildPdfDocument(conversation);
      const blob = new Blob([pdfBytes], { type: "application/pdf" });
      const fileName = `${slugify(conversation.title || fallbackTitle || "chatgpt-discussion")}.pdf`;
      triggerDownload(blob, fileName);
      showOverlayNotice(`PDF genere: ${fileName}`);
    } catch (error) {
      console.error("ChatGPT Performance Booster: PDF export failed", error);
      showOverlayNotice("Impossible de generer le PDF pour cette discussion.", true);
    } finally {
      activeExports.delete(conversationId);
      if (button) {
        button.disabled = false;
        button.setAttribute("data-cgpb-loading", "false");
      }
      scheduleRefresh();
    }
  }

  async function loadConversationForExport(conversationId, fallbackTitle) {
    const candidates = [
      `/backend-api/conversation/${conversationId}`,
      `/backend-api/conversation/${conversationId}?tree=true&rendering_mode=default`,
      `/backend-api/conversation/${conversationId}?history_and_training_disabled=false`
    ];

    for (const url of candidates) {
      try {
        const response = await fetch(url, {
          credentials: "include"
        });

        if (!response.ok) {
          continue;
        }

        const payload = await response.json();
        const conversation = parseConversationPayload(payload, fallbackTitle);
        if (conversation.messages.length > 0) {
          return conversation;
        }
      } catch (_error) {
        continue;
      }
    }

    const currentConversationId = extractConversationId(location.href);
    if (currentConversationId === conversationId) {
      const fromDom = parseConversationFromDom(fallbackTitle);
      if (fromDom.messages.length > 0) {
        return fromDom;
      }
    }

    throw new Error("Conversation data unavailable");
  }

  function parseConversationPayload(payload, fallbackTitle) {
    const messages = [];
    const mapping = payload?.mapping || payload?.conversation?.mapping;

    if (mapping && typeof mapping === "object") {
      Object.values(mapping).forEach((node) => {
        const message = node?.message;
        const role = message?.author?.role || "";
        if (!message || (role !== "user" && role !== "assistant")) {
          return;
        }

        const text = extractMessageText(message?.content);
        if (!text) {
          return;
        }

        messages.push({
          role,
          text,
          createdAt: Number(message?.create_time || node?.create_time || 0)
        });
      });
    } else if (Array.isArray(payload?.messages)) {
      payload.messages.forEach((message, index) => {
        const role = message?.author?.role || "";
        if (role !== "user" && role !== "assistant") {
          return;
        }

        const text = extractMessageText(message?.content);
        if (!text) {
          return;
        }

        messages.push({
          role,
          text,
          createdAt: Number(message?.create_time || index)
        });
      });
    }

    messages.sort((left, right) => left.createdAt - right.createdAt);

    return {
      title: String(payload?.title || fallbackTitle || "ChatGPT discussion").trim(),
      messages
    };
  }

  function extractMessageText(content) {
    if (!content) {
      return "";
    }

    if (typeof content === "string") {
      return normalizeExportText(content);
    }

    if (Array.isArray(content?.parts)) {
      return normalizeExportText(
        content.parts
          .map((part) => {
            if (typeof part === "string") {
              return part;
            }

            if (part && typeof part.text === "string") {
              return part.text;
            }

            return "";
          })
          .filter(Boolean)
          .join("\n\n")
      );
    }

    if (typeof content?.text === "string") {
      return normalizeExportText(content.text);
    }

    if (Array.isArray(content?.text)) {
      return normalizeExportText(content.text.join("\n"));
    }

    return "";
  }

  function parseConversationFromDom(fallbackTitle) {
    const turns = getTurnContainers();
    const messages = turns
      .map((turn, index) => {
        const role = getTurnRole(turn);
        if (role !== "user" && role !== "assistant") {
          return null;
        }

        const content = getTurnContentElement(turn);
        const text = normalizeExportText(content?.innerText || turn.innerText || "");
        if (!text) {
          return null;
        }

        return {
          role,
          text,
          createdAt: index
        };
      })
      .filter(Boolean);

    return {
      title: getCurrentConversationTitle() || fallbackTitle || "ChatGPT discussion",
      messages
    };
  }

  function getCurrentConversationTitle() {
    const headerTitle =
      document.querySelector("main h1") ||
      document.querySelector("header h1") ||
      document.querySelector("[data-testid='conversation-title']");

    if (headerTitle instanceof HTMLElement) {
      const text = headerTitle.textContent?.trim();
      if (text) {
        return text;
      }
    }

    return document.title.replace(/\s*\|\s*ChatGPT\s*$/i, "").trim();
  }

  function normalizeExportText(text) {
    return String(text || "")
      .replace(/\r/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function buildPdfDocument(conversation) {
    const contentWidth = PDF_PAGE_WIDTH - PDF_MARGIN * 2;
    const pageCommands = [];
    let currentCommands = [];
    let currentY = PDF_PAGE_HEIGHT - PDF_MARGIN;
    let isFirstPage = true;

    const startNewPage = () => {
      if (currentCommands.length > 0) {
        pageCommands.push(currentCommands.join("\n"));
      }

      currentCommands = [];
      currentY = PDF_PAGE_HEIGHT - PDF_MARGIN;
      drawPageHeader();
      isFirstPage = false;
    };

    const ensureSpace = (requiredHeight) => {
      if (currentY - requiredHeight < PDF_MARGIN) {
        startNewPage();
      }
    };

    const drawPageHeader = () => {
      const top = PDF_PAGE_HEIGHT - PDF_MARGIN + 6;

      currentCommands.push("0.10 0.65 0.46 rg");
      currentCommands.push(createHexBadgePath(PDF_MARGIN, top - 10, 10));
      currentCommands.push("/F2 18 Tf");
      currentCommands.push("0.08 0.11 0.16 rg");
      currentCommands.push(`BT 0 0 0 rg 70 ${top - 14} Td (${escapePdfText("ChatGPT")}) Tj ET`);
      currentCommands.push("/F1 10 Tf");
      currentCommands.push("0.42 0.48 0.55 rg");
      currentCommands.push(`BT 0 0 0 rg 70 ${top - 28} Td (${escapePdfText(conversation.title || "Discussion")}) Tj ET`);
      currentCommands.push("0.85 0.88 0.92 RG");
      currentCommands.push(`${PDF_MARGIN} ${top - 38} m ${PDF_PAGE_WIDTH - PDF_MARGIN} ${top - 38} l S`);

      currentY = top - 54;

      if (isFirstPage) {
        const meta = `Export ${new Date().toLocaleDateString("fr-FR")} - ${conversation.messages.length} messages`;
        currentCommands.push("/F1 9 Tf");
        currentCommands.push("0.42 0.48 0.55 rg");
        currentCommands.push(`BT 0 0 0 rg ${PDF_MARGIN} ${currentY} Td (${escapePdfText(meta)}) Tj ET`);
        currentY -= 24;
      }
    };

    startNewPage();

    conversation.messages.forEach((message) => {
      const label = message.role === "assistant" ? "Assistant" : "Vous";
      const paragraphs = message.text.split(/\n{2,}/).flatMap((paragraph) => {
        const lines = wrapPdfText(paragraph.replace(/\n/g, " "), contentWidth, PDF_FONT_SIZE);
        return lines.length > 0 ? lines : [""];
      });

      const blockHeight = 18 + paragraphs.length * PDF_LINE_HEIGHT + 10;
      ensureSpace(blockHeight);

      currentCommands.push("/F2 10 Tf");
      if (message.role === "assistant") {
        currentCommands.push("0.10 0.65 0.46 rg");
      } else {
        currentCommands.push("0.18 0.22 0.30 rg");
      }
      currentCommands.push(`BT 0 0 0 rg ${PDF_MARGIN} ${currentY} Td (${escapePdfText(label)}) Tj ET`);
      currentY -= 16;

      currentCommands.push("/F1 11 Tf");
      currentCommands.push("0.12 0.12 0.12 rg");
      paragraphs.forEach((line) => {
        ensureSpace(PDF_LINE_HEIGHT + 10);
        currentCommands.push(`BT 0 0 0 rg ${PDF_MARGIN} ${currentY} Td (${escapePdfText(line)}) Tj ET`);
        currentY -= PDF_LINE_HEIGHT;
      });

      currentCommands.push("0.90 0.92 0.95 RG");
      currentCommands.push(`${PDF_MARGIN} ${currentY + 4} m ${PDF_PAGE_WIDTH - PDF_MARGIN} ${currentY + 4} l S`);
      currentY -= 12;
    });

    if (currentCommands.length > 0) {
      pageCommands.push(currentCommands.join("\n"));
    }

    return createPdfFromPageStreams(pageCommands);
  }

  function wrapPdfText(text, maxWidth, fontSize) {
    const normalized = String(text || "").trim();
    if (!normalized) {
      return [];
    }

    const approxCharWidth = fontSize * 0.52;
    const maxChars = Math.max(24, Math.floor(maxWidth / approxCharWidth));
    const words = normalized.split(/\s+/);
    const lines = [];
    let current = "";

    words.forEach((word) => {
      const next = current ? `${current} ${word}` : word;
      if (next.length <= maxChars) {
        current = next;
        return;
      }

      if (current) {
        lines.push(current);
      }

      if (word.length <= maxChars) {
        current = word;
        return;
      }

      let chunk = word;
      while (chunk.length > maxChars) {
        lines.push(chunk.slice(0, maxChars));
        chunk = chunk.slice(maxChars);
      }
      current = chunk;
    });

    if (current) {
      lines.push(current);
    }

    return lines;
  }

  function createHexBadgePath(centerX, centerY, radius) {
    const points = [];
    for (let index = 0; index < 6; index += 1) {
      const angle = (-30 + index * 60) * (Math.PI / 180);
      points.push([
        roundNumber(centerX + radius * Math.cos(angle)),
        roundNumber(centerY + radius * Math.sin(angle))
      ]);
    }

    const [firstX, firstY] = points[0];
    const path = [`${firstX} ${firstY} m`];
    for (let index = 1; index < points.length; index += 1) {
      path.push(`${points[index][0]} ${points[index][1]} l`);
    }
    path.push("h f");
    return path.join("\n");
  }

  function createPdfFromPageStreams(pageStreams) {
    const objects = [];
    const pageRefs = [];

    objects.push("<< /Type /Catalog /Pages 2 0 R >>");
    objects.push(null);
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");

    pageStreams.forEach((stream, index) => {
      const contentObjectNumber = objects.length + 1;
      const pageObjectNumber = objects.length + 2;

      objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`
      );

      pageRefs.push(`${pageObjectNumber} 0 R`);
    });

    objects[1] = `<< /Type /Pages /Count ${pageRefs.length} /Kids [${pageRefs.join(" ")}] >>`;

    const parts = ["%PDF-1.4\n%CGPB\n"];
    const offsets = [0];
    let currentOffset = parts[0].length;

    objects.forEach((objectBody, index) => {
      offsets[index + 1] = currentOffset;
      const serialized = `${index + 1} 0 obj\n${objectBody}\nendobj\n`;
      parts.push(serialized);
      currentOffset += serialized.length;
    });

    const xrefOffset = currentOffset;
    parts.push(`xref\n0 ${objects.length + 1}\n`);
    parts.push("0000000000 65535 f \n");
    for (let index = 1; index <= objects.length; index += 1) {
      parts.push(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`);
    }
    parts.push(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
    );

    return new TextEncoder().encode(parts.join(""));
  }

  function roundNumber(value) {
    return Number(value.toFixed(2));
  }

  function escapePdfText(text) {
    return String(text || "")
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/[^\x20-\x7E]/g, (character) => {
        const code = character.charCodeAt(0);
        return `\\${code.toString(8).padStart(3, "0")}`;
      });
  }

  function triggerDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function slugify(value) {
    return String(value || "chatgpt-discussion")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "chatgpt-discussion";
  }

  function showOverlayNotice(message, isError) {
    if (!overlaySummary) {
      return;
    }

    window.clearTimeout(overlayNoticeTimer);
    const previousText = overlaySummary.textContent;
    overlaySummary.textContent = message;
    overlaySummary.setAttribute("data-cgpb-notice", isError ? "error" : "success");

    overlayNoticeTimer = window.setTimeout(() => {
      overlaySummary.removeAttribute("data-cgpb-notice");
      if (overlaySummary.textContent === message) {
        scheduleRefresh();
      } else {
        overlaySummary.textContent = previousText;
      }
    }, 2800);
  }
})();
