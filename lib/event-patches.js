/** Event-specific DOM / matching patches (per HKT projectId) */
const TICKPILOT_EVENT_PATCHES = {
  "50000001568003": {
    name: "BIGBANG 2026 Hong Kong",
    sessions: [
      { en: ["13 Nov", "Nov 13", "2026 (Fri)"], zh: ["11月13", "11月13日", "11/13"] },
      { en: ["14 Nov", "Nov 14", "2026 (Sat)"], zh: ["11月14", "11月14日", "11/14"] },
      { en: ["15 Nov", "Nov 15", "2026 (Sun)"], zh: ["11月15", "11月15日", "11/15"] },
    ],
    tierKeywords: "Ultimate,Diamond,Gold,VIP,Floor,2099,Standing,Riser",
    collectionPrefer: "qr",
    selectors: {
      sessionItem: '[class*="sessionList___"]',
      categoryItem: '[class*="levelItem___"]',
      categoryEnabled: '[class*="levelItem___"]:not([class*="disableClass___"]):not([disabled])',
      qtyStepper: '[class*="buyNum___"]',
      bottomBar: '[class*="sellTicketBottomBtnWrap___"], [class*="pcOrderBar___"]',
    },
  },
};

function getProjectIdFromUrl(url) {
  try {
    const u = new URL(url || location.href);
    const fromSearch = u.searchParams.get("projectId");
    if (fromSearch) return fromSearch;
    const m = (u.hash || "").match(/projectId=(\d+)/);
    return m ? m[1] : null;
  } catch (_e) {
    return null;
  }
}

function getEventPatch(url) {
  const id = getProjectIdFromUrl(url);
  return id ? TICKPILOT_EVENT_PATCHES[id] || null : null;
}

if (typeof globalThis !== "undefined") {
  globalThis.TICKPILOT_EVENT_PATCHES = TICKPILOT_EVENT_PATCHES;
  globalThis.getEventPatch = getEventPatch;
  globalThis.getProjectIdFromUrl = getProjectIdFromUrl;
}
