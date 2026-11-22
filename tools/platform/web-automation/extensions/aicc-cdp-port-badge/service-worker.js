importScripts("badge-config.js");

async function applyBadge() {
  const model = globalThis.AiccCdpBadge;
  const stored = await chrome.storage.local.get(model.storageKey);
  let slot = String(stored[model.storageKey] ?? "");
  const display = model.slots[slot] ?? model.unconfigured;
  await Promise.all([
    chrome.action.setBadgeText({ text: display.badge }),
    chrome.action.setBadgeBackgroundColor({ color: display.color }),
    chrome.action.setTitle({ title: display.label })
  ]);
}

chrome.runtime.onInstalled.addListener(() => void applyBadge());
chrome.runtime.onStartup.addListener(() => void applyBadge());
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && Object.hasOwn(changes, globalThis.AiccCdpBadge.storageKey)) void applyBadge();
});
void applyBadge();
