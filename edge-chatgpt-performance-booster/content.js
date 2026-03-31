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
    reduceEffects: true,
    pdfExportEnabled: true
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
  let overlayLoadButton = null;
  let overlayRevealAllButton = null;
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
      reduceEffects: raw.reduceEffects !== false,
      pdfExportEnabled: raw.pdfExportEnabled !== false
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
      collapsedReplies: Object.create(null)
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

    updateReplyActions(turns, conversationState);

    updateOverlay({
      totalCount,
      targetVisibleCount,
      hiddenCount,
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

  function updateReplyActions(turns, conversationState) {
    turns.forEach((turn, index) => {
      const role = getTurnRole(turn);
      if (role !== "assistant" || turn.dataset.cgpbHidden === "true") {
        cleanupReplyEnhancements(turn);
        return;
      }

      const content = getTurnContentElement(turn);
      if (!(content instanceof HTMLElement)) {
        cleanupReplyEnhancements(turn);
        return;
      }

      const slot = ensureReplyActionSlot(turn);
      if (!(slot instanceof HTMLElement)) {
        cleanupReplyEnhancements(turn);
        return;
      }

      const key = getTurnKey(turn, index);
      const textLength = (content.innerText || content.textContent || "").trim().length;
      const isLong =
        content.scrollHeight > LONG_REPLY_HEIGHT_PX ||
        textLength > LONG_REPLY_TEXT_LENGTH ||
        content.querySelectorAll("pre, table, ul, ol, blockquote").length >= 3;

      if (isLong) {
        const isCollapsed = conversationState.collapsedReplies[key] === true;
        const button = ensureInlineActionButton(slot, "cgpb-collapse-action", "Collapse");

        turn.classList.add("cgpb-collapsible-turn");
        turn.dataset.cgpbCollapseKey = key;
        turn.dataset.cgpbCollapsed = isCollapsed ? "true" : "false";
        content.classList.add("cgpb-long-reply-target");
        content.dataset.cgpbCollapseKey = key;
        button.textContent = isCollapsed ? "Expand" : "Collapse";
        button.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
        button.onclick = () => {
          const state = getConversationState();
          state.collapsedReplies[key] = !(state.collapsedReplies[key] === true);
          scheduleRefresh();
        };
      } else {
        turn.classList.remove("cgpb-collapsible-turn");
        turn.removeAttribute("data-cgpb-collapsed");
        turn.removeAttribute("data-cgpb-collapse-key");
        content.classList.remove("cgpb-long-reply-target");
        content.removeAttribute("data-cgpb-collapse-key");
        removeInlineActionButton(slot, ".cgpb-collapse-action");
      }

      if (settings.pdfExportEnabled) {
        const pdfButton = ensureInlineActionButton(slot, "cgpb-pdf-action", "PDF");
        const exportKey = `reply:${key}`;
        pdfButton.disabled = activeExports.has(exportKey);
        pdfButton.setAttribute("data-cgpb-loading", activeExports.has(exportKey) ? "true" : "false");
        pdfButton.title = "Telecharger cette reponse en PDF";
        pdfButton.onclick = () => {
          exportAssistantReplyPdf(turn, index, pdfButton);
        };
      } else {
        removeInlineActionButton(slot, ".cgpb-pdf-action");
      }

      if (!slot.childElementCount) {
        slot.remove();
      }
    });
  }

  function cleanupReplyEnhancements(turn) {
    turn.classList.remove("cgpb-collapsible-turn");
    turn.removeAttribute("data-cgpb-collapsed");
    turn.removeAttribute("data-cgpb-collapse-key");

    turn.querySelectorAll(".cgpb-long-reply-target").forEach((node) => {
      node.classList.remove("cgpb-long-reply-target");
      node.removeAttribute("data-cgpb-collapse-key");
    });

    const slot = turn.querySelector(".cgpb-inline-slot");
    if (slot) {
      slot.remove();
    }
  }

  function ensureReplyActionSlot(turn) {
    const existing = turn.querySelector(".cgpb-inline-slot");
    if (existing instanceof HTMLElement) {
      return existing;
    }

    const host = getLikelyActionBar(turn);
    const slot = document.createElement("div");
    slot.className = "cgpb-inline-slot";

    if (host instanceof HTMLElement) {
      host.appendChild(slot);
      return slot;
    }

    return null;
  }

  function getLikelyActionBar(turn) {
    const buttons = Array.from(turn.querySelectorAll("button")).filter((button) => {
      if (!(button instanceof HTMLButtonElement)) {
        return false;
      }

      if (button.closest("#cgpb-overlay") || button.closest(".cgpb-inline-slot") || button.closest("pre")) {
        return false;
      }

      return button.getClientRects().length > 0;
    });

    if (!buttons.length) {
      return null;
    }

    const maxBottom = Math.max(...buttons.map((button) => button.getBoundingClientRect().bottom));
    const bottomButtons = buttons.filter((button) => maxBottom - button.getBoundingClientRect().bottom < 24);
    if (bottomButtons.length < 2) {
      return null;
    }
    const parentCounts = new Map();

    bottomButtons.forEach((button) => {
      const parent = button.parentElement;
      if (parent && parent !== turn) {
        parentCounts.set(parent, (parentCounts.get(parent) || 0) + 1);
      }
    });

    let bestParent = null;
    let bestScore = -1;

    parentCounts.forEach((score, parent) => {
      if (score > bestScore) {
        bestParent = parent;
        bestScore = score;
      }
    });

    if (bestParent instanceof HTMLElement) {
      return bestParent;
    }

    return bottomButtons[0]?.parentElement || null;
  }

  function ensureInlineActionButton(slot, className, label) {
    let button = slot.querySelector(`.${className}`);
    if (button instanceof HTMLButtonElement) {
      return button;
    }

    button = document.createElement("button");
    button.type = "button";
    button.className = `cgpb-inline-action ${className}`;
    button.textContent = label;
    slot.appendChild(button);
    return button;
  }

  function removeInlineActionButton(slot, selector) {
    const button = slot.querySelector(selector);
    if (button) {
      button.remove();
    }
  }

  async function exportAssistantReplyPdf(turn, index, button) {
    const key = `reply:${getTurnKey(turn, index)}`;
    if (activeExports.has(key)) {
      return;
    }

    activeExports.add(key);
    button.disabled = true;
    button.setAttribute("data-cgpb-loading", "true");

    try {
      const replyText = collectTurnText(turn);
      if (!replyText) {
        throw new Error("Empty reply");
      }

      const title = getCurrentConversationTitle() || "ChatGPT";
      const pdfBytes = buildPdfDocument({
        title,
        messages: [
          {
            role: "assistant",
            text: replyText
          }
        ]
      });
      const blob = new Blob([pdfBytes], { type: "application/pdf" });
      const fileName = `${slugify(title)}-reply-${index + 1}.pdf`;
      triggerDownload(blob, fileName);
    } catch (error) {
      console.error("ChatGPT Performance Booster: response PDF export failed", error);
    } finally {
      activeExports.delete(key);
      button.disabled = false;
      button.setAttribute("data-cgpb-loading", "false");
      scheduleRefresh();
    }
  }

  function collectTurnText(turn) {
    const content = getTurnContentElement(turn);
    return normalizeExportText(content?.innerText || turn.innerText || "");
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
      '  <div class="cgpb-actions">',
      '    <button type="button" id="cgpb-load-more">More</button>',
      '    <button type="button" id="cgpb-reveal-all">All</button>',
      "  </div>",
      "</div>"
    ].join("");

    overlayLoadButton = overlay.querySelector("#cgpb-load-more");
    overlayRevealAllButton = overlay.querySelector("#cgpb-reveal-all");

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

  function updateOverlay({ totalCount, targetVisibleCount, hiddenCount, shouldTrim }) {
    if (!overlay) {
      return;
    }

    const shouldShowOverlay = settings.enabled && settings.showStatusBadge && totalCount > 0;
    overlay.hidden = !shouldShowOverlay;

    if (!shouldShowOverlay) {
      return;
    }

    toggleActionButtons({
      loadMore: hiddenCount > 0,
      revealAll: shouldTrim && targetVisibleCount < totalCount
    });
  }

  function toggleActionButtons({ loadMore, revealAll }) {
    if (overlayLoadButton) {
      overlayLoadButton.disabled = !loadMore;
      overlayLoadButton.setAttribute("aria-disabled", loadMore ? "false" : "true");
      overlayLoadButton.title = loadMore ? `Afficher ${settings.loadBatchSize} messages de plus` : "Aucun message supplementaire masque";
    }

    if (overlayRevealAllButton) {
      overlayRevealAllButton.disabled = !revealAll;
      overlayRevealAllButton.setAttribute("aria-disabled", revealAll ? "false" : "true");
      overlayRevealAllButton.title = revealAll ? "Afficher toute la conversation" : "Toute la conversation est deja visible";
    }
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
})();
