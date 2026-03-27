(function () {
  if (window.__chatGptWarmMinimalLoaded) {
    return;
  }

  window.__chatGptWarmMinimalLoaded = true;

  const EXTENSION_FLAG = "data-chatgpt-warm-minimal";
  const PANEL_ID = "cgwm-panel";
  const ACTIVE_WINDOW_MS = 4500;
  const STALE_WINDOW_MS = 15000;
  const REFRESH_INTERVAL_MS = 1000;
  const THINKING_TEXT = /\b(thinking|reasoning|analyzing|analysis|reflecting|drafting|writing|responding|generating|reponse|reaction|generation|reflexion|raisonnement|analyse|ecriture)\b/i;
  const STOP_TEXT = /\b(stop|cancel|arr[eê]ter|interrompre|annuler)\b/i;
  const RESPONSE_SELECTORS = [
    '[data-message-author-role="assistant"] .markdown',
    '[data-message-author-role="assistant"] [class*="markdown"]',
    "main article .markdown",
    'main article [class*="markdown"]',
    'main [class*="prose"]'
  ];

  let panelRoot = null;
  let listRoot = null;
  let emptyRoot = null;
  let generationCounter = 0;
  let refreshQueued = false;

  const trackedResponses = new Map();

  function ensureBodyFlag() {
    if (!document.body) {
      return false;
    }

    document.body.setAttribute(EXTENSION_FLAG, "true");
    return true;
  }

  function visibleText(node) {
    return (node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(node) {
    if (!node || !node.isConnected) {
      return false;
    }

    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    return node.getClientRects().length > 0;
  }

  function getResponseNodes() {
    const seenNodes = new Set();
    const seenContainers = new Set();
    const nodes = [];

    RESPONSE_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        if (!(node instanceof HTMLElement)) {
          return;
        }

        if (!node.closest("main")) {
          return;
        }

        if (node.closest(`#${PANEL_ID}`)) {
          return;
        }

        if (node.closest("form")) {
          return;
        }

        const turnContainer = getTurnContainer(node);
        if (turnContainer && seenContainers.has(turnContainer)) {
          return;
        }

        const text = visibleText(node);
        const hasStructuredContent = node.querySelector("p, ul, ol, pre, table, blockquote, h1, h2, h3, h4, h5, h6");

        if (text.length < 30 && !hasStructuredContent) {
          return;
        }

        if (seenNodes.has(node)) {
          return;
        }

        seenNodes.add(node);
        if (turnContainer) {
          seenContainers.add(turnContainer);
        }
        nodes.push(node);
      });
    });

    nodes.sort((left, right) => {
      const position = left.compareDocumentPosition(right);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
        return -1;
      }
      if (position & Node.DOCUMENT_POSITION_PRECEDING) {
        return 1;
      }
      return 0;
    });

    return nodes;
  }

  function getTurnContainer(node) {
    return (
      node.closest('[data-message-author-role="assistant"]') ||
      node.closest("article") ||
      node.closest("section") ||
      node.parentElement
    );
  }

  function getStatusTextNear(node) {
    const container = getTurnContainer(node);
    if (!container) {
      return "";
    }

    const candidates = container.querySelectorAll('[role="status"], [aria-live="polite"], [aria-live="assertive"], button');

    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement) || !isVisible(candidate)) {
        continue;
      }

      const text = visibleText(candidate);
      if (text.length > 80) {
        continue;
      }

      if (THINKING_TEXT.test(text)) {
        return text;
      }
    }

    return "";
  }

  function hasGlobalStopControl() {
    const buttons = document.querySelectorAll("main button, form button");

    for (const button of buttons) {
      if (!(button instanceof HTMLElement) || !isVisible(button)) {
        continue;
      }

      const label = [
        button.getAttribute("aria-label") || "",
        button.getAttribute("title") || "",
        visibleText(button)
      ].join(" ");

      if (STOP_TEXT.test(label)) {
        return true;
      }
    }

    return false;
  }

  function getGlobalThinkingText() {
    const nodes = document.querySelectorAll('main [role="status"], main [aria-live="polite"], main [aria-live="assertive"]');

    for (const node of nodes) {
      if (!(node instanceof HTMLElement) || !isVisible(node)) {
        continue;
      }

      const text = visibleText(node);
      if (text.length && THINKING_TEXT.test(text)) {
        return text;
      }
    }

    return "";
  }

  function ensureTrackedEntry(node) {
    if (!node.dataset.cgwmResponseId) {
      generationCounter += 1;
      node.dataset.cgwmResponseId = `cgwm-response-${generationCounter}`;
    }

    const id = node.dataset.cgwmResponseId;
    if (!trackedResponses.has(id)) {
      trackedResponses.set(id, {
        id,
        node,
        title: `Reponse ${trackedResponses.size + 1}`,
        createdAt: Date.now(),
        lastSeenAt: 0,
        lastMutationAt: 0,
        lastText: ""
      });
    }

    return trackedResponses.get(id);
  }

  function updateTrackedResponses() {
    const now = Date.now();
    const responseNodes = getResponseNodes();
    const seenIds = new Set();

    responseNodes.forEach((node, index) => {
      const entry = ensureTrackedEntry(node);
      const text = visibleText(node);
      const statusText = getStatusTextNear(node);
      const turnContainer = getTurnContainer(node);

      entry.node = node;
      entry.lastSeenAt = now;
      entry.index = index + 1;
      entry.title = `Reponse ${index + 1}`;
      entry.turnContainer = turnContainer;
      entry.statusText = statusText;

      if (turnContainer instanceof HTMLElement) {
        turnContainer.classList.add("cgwm-turn");
      }

      node.classList.add("cgwm-response-body");

      if (text !== entry.lastText) {
        entry.lastText = text;
        entry.lastMutationAt = now;
      }

      seenIds.add(entry.id);
    });

    for (const [id, entry] of trackedResponses.entries()) {
      const stale = now - entry.lastSeenAt > STALE_WINDOW_MS;
      if (!seenIds.has(id) && stale) {
        trackedResponses.delete(id);
      }
    }
  }

  function getActiveEntries() {
    const now = Date.now();
    const active = [];

    for (const entry of trackedResponses.values()) {
      if (!entry.node?.isConnected) {
        continue;
      }

      const timeSinceMutation = now - entry.lastMutationAt;
      const thinking = entry.statusText && THINKING_TEXT.test(entry.statusText);
      const generating = timeSinceMutation <= ACTIVE_WINDOW_MS;

      if (!thinking && !generating) {
        continue;
      }

      active.push({
        id: entry.id,
        node: entry.turnContainer || entry.node,
        title: entry.title,
        status: thinking && !generating ? "thinking" : "generating",
        label: thinking && !generating ? "Reflexion" : "Generation",
        excerpt: getExcerpt(entry.lastText, thinking),
        ageMs: generating ? timeSinceMutation : now - entry.createdAt
      });
    }

    if (!active.length && hasGlobalStopControl()) {
      const fallbackNode = getResponseNodes().slice(-1)[0] || null;
      const globalThinkingText = getGlobalThinkingText();

      active.push({
        id: "cgwm-global-pending",
        node: fallbackNode,
        title: "Reponse en preparation",
        status: globalThinkingText ? "thinking" : "generating",
        label: globalThinkingText ? "Reflexion" : "Generation",
        excerpt: globalThinkingText || "ChatGPT prepare une reponse sur cette conversation.",
        ageMs: 0
      });
    }

    active.sort((left, right) => left.ageMs - right.ageMs);
    return active;
  }

  function getExcerpt(text, isThinking) {
    if (!text) {
      return isThinking ? "Le raisonnement est en cours..." : "La reponse est en train d'apparaitre...";
    }

    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length <= 140) {
      return compact;
    }

    return `${compact.slice(0, 137)}...`;
  }

  function ensurePanel() {
    if (panelRoot?.isConnected) {
      return;
    }

    panelRoot = document.createElement("aside");
    panelRoot.id = PANEL_ID;
    panelRoot.innerHTML = [
      '<div class="cgwm-panel__header">',
      '  <div>',
      '    <p class="cgwm-panel__eyebrow">ChatGPT</p>',
      '    <h2 class="cgwm-panel__title">En cours</h2>',
      "  </div>",
      '  <span class="cgwm-panel__badge">live</span>',
      "</div>",
      '<p class="cgwm-panel__intro">Les reponses qui sont encore en reflexion ou en generation apparaissent ici.</p>',
      '<div class="cgwm-panel__empty">Aucune generation detectee pour le moment.</div>',
      '<div class="cgwm-panel__list" role="list"></div>'
    ].join("");

    listRoot = panelRoot.querySelector(".cgwm-panel__list");
    emptyRoot = panelRoot.querySelector(".cgwm-panel__empty");

    document.body.appendChild(panelRoot);
  }

  function formatAge(ageMs) {
    const seconds = Math.max(0, Math.round(ageMs / 1000));
    if (seconds < 60) {
      return `${seconds}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${minutes}m ${rest}s`;
  }

  function renderActivePanel() {
    ensurePanel();

    if (!listRoot || !emptyRoot) {
      return;
    }

    const active = getActiveEntries();
    emptyRoot.hidden = active.length > 0;
    listRoot.innerHTML = "";

    active.forEach((entry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `cgwm-panel__item cgwm-panel__item--${entry.status}`;
      button.setAttribute("role", "listitem");
      button.innerHTML = [
        '<div class="cgwm-panel__item-top">',
        `  <span class="cgwm-panel__status">${entry.label}</span>`,
        `  <span class="cgwm-panel__timer">${formatAge(entry.ageMs)}</span>`,
        "</div>",
        `  <strong class="cgwm-panel__item-title">${entry.title}</strong>`,
        `  <span class="cgwm-panel__excerpt">${entry.excerpt}</span>`
      ].join("");

      button.addEventListener("click", () => {
        if (entry.node instanceof HTMLElement) {
          entry.node.scrollIntoView({
            behavior: "smooth",
            block: "center"
          });
        }
      });

      listRoot.appendChild(button);
    });
  }

  function refresh() {
    if (!ensureBodyFlag()) {
      return;
    }

    updateTrackedResponses();
    renderActivePanel();
  }

  function queueRefresh() {
    if (refreshQueued) {
      return;
    }

    refreshQueued = true;
    window.requestAnimationFrame(() => {
      refreshQueued = false;
      refresh();
    });
  }

  function observePage() {
    const observer = new MutationObserver(() => {
      queueRefresh();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });

    window.setInterval(refresh, REFRESH_INTERVAL_MS);
    window.addEventListener("resize", queueRefresh, { passive: true });
    document.addEventListener("visibilitychange", queueRefresh);
  }

  function boot() {
    if (!ensureBodyFlag()) {
      window.setTimeout(boot, 150);
      return;
    }

    ensurePanel();
    refresh();
    observePage();
  }

  boot();
})();
