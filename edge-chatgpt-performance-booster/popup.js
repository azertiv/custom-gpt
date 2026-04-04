const STORAGE_KEY = "cgpb-settings";
const DEFAULT_SETTINGS = {
  enabled: true,
  themeEnabled: true,
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

const formElements = {
  enabled: document.getElementById("enabled"),
  visibleCount: document.getElementById("visibleCount"),
  visibleCountValue: document.getElementById("visibleCountValue"),
  loadBatchSize: document.getElementById("loadBatchSize"),
  loadBatchSizeValue: document.getElementById("loadBatchSizeValue"),
  trimThreshold: document.getElementById("trimThreshold"),
  trimThresholdValue: document.getElementById("trimThresholdValue"),
  themeEnabled: document.getElementById("themeEnabled"),
  reduceEffects: document.getElementById("reduceEffects"),
  showStatusBadge: document.getElementById("showStatusBadge"),
  cleanupOnSwitch: document.getElementById("cleanupOnSwitch"),
  lazyRenderMedia: document.getElementById("lazyRenderMedia"),
  lazyRenderMargin: document.getElementById("lazyRenderMargin"),
  lazyRenderMarginValue: document.getElementById("lazyRenderMarginValue"),
  observerThrottleMs: document.getElementById("observerThrottleMs"),
  observerThrottleMsValue: document.getElementById("observerThrottleMsValue"),
  scrollDebounceMs: document.getElementById("scrollDebounceMs"),
  scrollDebounceMsValue: document.getElementById("scrollDebounceMsValue"),
  resetDefaults: document.getElementById("resetDefaults"),
  status: document.getElementById("status")
};

let saveTimer = 0;

bootstrap().catch((error) => {
  formElements.status.textContent = `Erreur: ${error.message}`;
});

async function bootstrap() {
  const settings = normalizeSettings((await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {});
  render(settings);
  attachListeners();
}

function normalizeSettings(raw) {
  return {
    enabled: raw.enabled !== false,
    themeEnabled: raw.themeEnabled !== false,
    visibleCount: clamp(raw.visibleCount, 3, 80, DEFAULT_SETTINGS.visibleCount),
    loadBatchSize: clamp(raw.loadBatchSize, 1, 40, DEFAULT_SETTINGS.loadBatchSize),
    trimThreshold: clamp(raw.trimThreshold, 6, 200, DEFAULT_SETTINGS.trimThreshold),
    showStatusBadge: raw.showStatusBadge !== false,
    reduceEffects: raw.reduceEffects !== false,
    cleanupOnSwitch: raw.cleanupOnSwitch === true,
    lazyRenderMedia: raw.lazyRenderMedia !== false,
    lazyRenderMargin: clamp(raw.lazyRenderMargin, 0, 1000, DEFAULT_SETTINGS.lazyRenderMargin),
    observerThrottleMs: clamp(raw.observerThrottleMs, 16, 500, DEFAULT_SETTINGS.observerThrottleMs),
    scrollDebounceMs: clamp(raw.scrollDebounceMs, 16, 500, DEFAULT_SETTINGS.scrollDebounceMs)
  };
}

function clamp(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function render(settings) {
  formElements.enabled.checked = settings.enabled;
  formElements.themeEnabled.checked = settings.themeEnabled;
  formElements.visibleCount.value = String(settings.visibleCount);
  formElements.visibleCountValue.textContent = String(settings.visibleCount);
  formElements.loadBatchSize.value = String(settings.loadBatchSize);
  formElements.loadBatchSizeValue.textContent = String(settings.loadBatchSize);
  formElements.trimThreshold.value = String(settings.trimThreshold);
  formElements.trimThresholdValue.textContent = String(settings.trimThreshold);
  formElements.reduceEffects.checked = settings.reduceEffects;
  formElements.showStatusBadge.checked = settings.showStatusBadge;
  formElements.cleanupOnSwitch.checked = settings.cleanupOnSwitch;
  formElements.lazyRenderMedia.checked = settings.lazyRenderMedia;
  formElements.lazyRenderMargin.value = String(settings.lazyRenderMargin);
  formElements.lazyRenderMarginValue.textContent = String(settings.lazyRenderMargin);
  formElements.observerThrottleMs.value = String(settings.observerThrottleMs);
  formElements.observerThrottleMsValue.textContent = String(settings.observerThrottleMs);
  formElements.scrollDebounceMs.value = String(settings.scrollDebounceMs);
  formElements.scrollDebounceMsValue.textContent = String(settings.scrollDebounceMs);
}

function attachListeners() {
  [
    formElements.enabled,
    formElements.themeEnabled,
    formElements.visibleCount,
    formElements.loadBatchSize,
    formElements.trimThreshold,
    formElements.reduceEffects,
    formElements.showStatusBadge,
    formElements.cleanupOnSwitch,
    formElements.lazyRenderMedia,
    formElements.lazyRenderMargin,
    formElements.observerThrottleMs,
    formElements.scrollDebounceMs
  ].forEach((element) => {
    element.addEventListener("input", handleInputChange);
    element.addEventListener("change", handleInputChange);
  });

  formElements.resetDefaults.addEventListener("click", async () => {
    render(DEFAULT_SETTINGS);
    await chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_SETTINGS });
    setStatus("Reglages par defaut restaures.");
  });
}

function handleInputChange() {
  formElements.visibleCountValue.textContent = formElements.visibleCount.value;
  formElements.loadBatchSizeValue.textContent = formElements.loadBatchSize.value;
  formElements.trimThresholdValue.textContent = formElements.trimThreshold.value;
  formElements.lazyRenderMarginValue.textContent = formElements.lazyRenderMargin.value;
  formElements.observerThrottleMsValue.textContent = formElements.observerThrottleMs.value;
  formElements.scrollDebounceMsValue.textContent = formElements.scrollDebounceMs.value;

  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    const nextSettings = normalizeSettings({
      enabled: formElements.enabled.checked,
      themeEnabled: formElements.themeEnabled.checked,
      visibleCount: formElements.visibleCount.value,
      loadBatchSize: formElements.loadBatchSize.value,
      trimThreshold: formElements.trimThreshold.value,
      reduceEffects: formElements.reduceEffects.checked,
      showStatusBadge: formElements.showStatusBadge.checked,
      cleanupOnSwitch: formElements.cleanupOnSwitch.checked,
      lazyRenderMedia: formElements.lazyRenderMedia.checked,
      lazyRenderMargin: formElements.lazyRenderMargin.value,
      observerThrottleMs: formElements.observerThrottleMs.value,
      scrollDebounceMs: formElements.scrollDebounceMs.value
    });

    await chrome.storage.local.set({ [STORAGE_KEY]: nextSettings });
    setStatus("Reglages enregistres.");
  }, 120);
}

function setStatus(message) {
  formElements.status.textContent = message;
}
