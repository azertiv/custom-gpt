const STORAGE_KEY = "cgpb-settings";
const DEFAULT_SETTINGS = {
  enabled: true,
  visibleCount: 12,
  loadBatchSize: 10,
  trimThreshold: 18,
  showStatusBadge: true,
  reduceEffects: true
};

const formElements = {
  enabled: document.getElementById("enabled"),
  visibleCount: document.getElementById("visibleCount"),
  visibleCountValue: document.getElementById("visibleCountValue"),
  loadBatchSize: document.getElementById("loadBatchSize"),
  loadBatchSizeValue: document.getElementById("loadBatchSizeValue"),
  trimThreshold: document.getElementById("trimThreshold"),
  trimThresholdValue: document.getElementById("trimThresholdValue"),
  reduceEffects: document.getElementById("reduceEffects"),
  showStatusBadge: document.getElementById("showStatusBadge"),
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
    visibleCount: clamp(raw.visibleCount, 3, 80, DEFAULT_SETTINGS.visibleCount),
    loadBatchSize: clamp(raw.loadBatchSize, 1, 40, DEFAULT_SETTINGS.loadBatchSize),
    trimThreshold: clamp(raw.trimThreshold, 6, 200, DEFAULT_SETTINGS.trimThreshold),
    showStatusBadge: raw.showStatusBadge !== false,
    reduceEffects: raw.reduceEffects !== false
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
  formElements.visibleCount.value = String(settings.visibleCount);
  formElements.visibleCountValue.value = String(settings.visibleCount);
  formElements.visibleCountValue.textContent = String(settings.visibleCount);
  formElements.loadBatchSize.value = String(settings.loadBatchSize);
  formElements.loadBatchSizeValue.value = String(settings.loadBatchSize);
  formElements.loadBatchSizeValue.textContent = String(settings.loadBatchSize);
  formElements.trimThreshold.value = String(settings.trimThreshold);
  formElements.trimThresholdValue.value = String(settings.trimThreshold);
  formElements.trimThresholdValue.textContent = String(settings.trimThreshold);
  formElements.reduceEffects.checked = settings.reduceEffects;
  formElements.showStatusBadge.checked = settings.showStatusBadge;
}

function attachListeners() {
  [
    formElements.enabled,
    formElements.visibleCount,
    formElements.loadBatchSize,
    formElements.trimThreshold,
    formElements.reduceEffects,
    formElements.showStatusBadge
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
  formElements.visibleCountValue.value = formElements.visibleCount.value;
  formElements.visibleCountValue.textContent = formElements.visibleCount.value;
  formElements.loadBatchSizeValue.value = formElements.loadBatchSize.value;
  formElements.loadBatchSizeValue.textContent = formElements.loadBatchSize.value;
  formElements.trimThresholdValue.value = formElements.trimThreshold.value;
  formElements.trimThresholdValue.textContent = formElements.trimThreshold.value;

  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    const nextSettings = normalizeSettings({
      enabled: formElements.enabled.checked,
      visibleCount: formElements.visibleCount.value,
      loadBatchSize: formElements.loadBatchSize.value,
      trimThreshold: formElements.trimThreshold.value,
      reduceEffects: formElements.reduceEffects.checked,
      showStatusBadge: formElements.showStatusBadge.checked
    });

    await chrome.storage.local.set({ [STORAGE_KEY]: nextSettings });
    setStatus("Reglages enregistres.");
  }, 120);
}

function setStatus(message) {
  formElements.status.textContent = message;
}
