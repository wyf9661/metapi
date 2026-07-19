/**
 * Vendor initialization presets are no longer used.
 * MetAPI is a hub for relay sites, not a vendor API catalog.
 * These exports are kept as stubs so existing callers compile
 * but never surface vendor presets in the UI.
 */

export function listSiteInitializationPresets() {
  return [];
}

export function getSiteInitializationPreset(_id) {
  return null;
}

export function detectSiteInitializationPreset(_url, _platform) {
  return null;
}
