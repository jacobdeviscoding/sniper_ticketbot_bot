/** TickPilot live-bot defaults */
const TICKPILOT_DEFAULTS = {
  platform: "hkt",
  locale: "en",
  interval: 500,
  maxRetries: 200,
  quantity: 1,
  sessionIndex: 1,
  sessionMatch: "13 Nov",
  zoneRange: "1-99",
  kktixPriceIndex: 2,
  minPrice: 2099,
  maxPrice: 3099,
  tierKeywords: "Ultimate,Diamond,Gold,VIP,Floor,2099",
  preferHigherPrice: true,
  memberNumber: "",
  presetAnswer: "",
  autoConsent: true,
  autoStart: false,
  function1Enabled: false,
  function2Enabled: true,
  skipObstructed: true,
  skipWheelchair: true,
  rotateTiers: false,
  diagnostics: true,
  dualTab: true,
  notifyOnSelect: true,
  soundAlert: true,
  antiBlock: true,
  autoCollection: true,
  collectionMethod: "qr",
  eventProjectId: "50000001568003",
  rotateSessions: true,
  tierFallback: true,
  apiRadar: true,
  apiPollMs: 1500,
  apiPollMsQueue: 900,
  apiPollMsSelect: 600,
  selectTurbo: true,
  apiStopInQueue: true,
};

function parseZoneRange(text) {
  const m = String(text || "1-3").match(/(\d+)\s*-\s*(\d+)/);
  if (!m) return { min: 1, max: 99 };
  return { min: Math.min(+m[1], +m[2]), max: Math.max(+m[1], +m[2]) };
}

if (typeof globalThis !== "undefined") {
  globalThis.TICKPILOT_DEFAULTS = TICKPILOT_DEFAULTS;
  globalThis.parseZoneRange = parseZoneRange;
}
