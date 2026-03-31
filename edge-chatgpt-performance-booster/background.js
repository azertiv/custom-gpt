const STORAGE_KEY = "cgpb-settings";
const DEFAULT_SETTINGS = {
  enabled: true,
  visibleCount: 12,
  loadBatchSize: 10,
  trimThreshold: 18,
  showStatusBadge: true,
  reduceEffects: true,
  pdfExportEnabled: true
};

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaultSettings().then(updateBadge);
});

chrome.runtime.onStartup.addListener(() => {
  ensureDefaultSettings().then(updateBadge);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEY]) {
    return;
  }

  updateBadge(changes[STORAGE_KEY].newValue || DEFAULT_SETTINGS);
});

async function ensureDefaultSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const merged = { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEY] || {}) };

  if (!result[STORAGE_KEY] || JSON.stringify(result[STORAGE_KEY]) !== JSON.stringify(merged)) {
    await chrome.storage.local.set({ [STORAGE_KEY]: merged });
  }

  return merged;
}

async function updateBadge(settings) {
  const resolvedSettings = settings || (await ensureDefaultSettings());
  const enabled = resolvedSettings.enabled !== false;

  await chrome.action.setBadgeBackgroundColor({
    color: enabled ? "#1f9d55" : "#5f6b7a"
  });

  await chrome.action.setBadgeText({
    text: enabled ? "FAST" : "OFF"
  });
}
