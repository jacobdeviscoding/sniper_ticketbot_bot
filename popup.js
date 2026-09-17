function $(id) {

  return document.getElementById(id);

}



function send(type, extra) {

  return chrome.runtime.sendMessage({ type, ...extra });

}



function readOptionsFromForm() {

  const platform = document.querySelector('input[name="platform"]:checked')?.value || "hkt";

  return {

    platform,

    locale: "en",

    interval: Number($("refresh-interval").value),

    maxRetries: Math.max(1, Number($("max-retries").value) || 200),

    quantity: Math.min(2, Math.max(1, Number($("quantity").value) || 1)),

    sessionIndex: Math.max(1, Number($("session-index").value) || 1),

    sessionMatch: $("session-match").value.trim(),

    zoneRange: $("zone-range").value.trim() || "1-99",

    minPrice: Number($("min-price").value) || 0,

    maxPrice: Number($("max-price").value) || 100000,

    memberNumber: $("member-number").value.trim(),

    presetAnswer: $("preset-answer").value.trim(),

    tierKeywords: $("tier-keywords").value.trim(),

    preferHigherPrice: true,

    autoConsent: $("auto-consent").checked,

    skipObstructed: $("skip-obstructed").checked,

    skipWheelchair: $("skip-wheelchair").checked,

    rotateTiers: false,

    diagnostics: $("diagnostics").checked,

    dualTab: $("dual-tab").checked,

    notifyOnSelect: $("notify-select").checked,

    soundAlert: $("sound-alert").checked,

    antiBlock: $("anti-block").checked,

    autoCollection: $("auto-collection").checked,

    collectionMethod: $("collection-method").value,

    rotateSessions: $("rotate-sessions").checked,

    tierFallback: $("tier-fallback").checked,

    apiRadar: $("api-radar").checked,

    apiStopInQueue: $("api-stop-queue").checked,

    selectTurbo: $("select-turbo").checked,

    apiPollMs: 1500,

    apiPollMsQueue: 900,

    apiPollMsSelect: 600,

    eventProjectId: "50000001568003",

    function1Enabled: false,

    function2Enabled: true,

  };

}



function writeOptionsToForm(options) {

  document.querySelector(`input[name="platform"][value="${options.platform || "hkt"}"]`).checked = true;

  $("refresh-interval").value = String(options.interval || 500);

  $("max-retries").value = options.maxRetries ?? 200;

  $("quantity").value = options.quantity ?? 1;

  $("session-index").value = options.sessionIndex ?? 1;

  $("session-match").value = options.sessionMatch || "13 Nov";

  $("zone-range").value = options.zoneRange || "1-99";

  $("min-price").value = options.minPrice ?? 2099;

  $("max-price").value = options.maxPrice ?? 100000;

  $("member-number").value = options.memberNumber || "";

  $("preset-answer").value = options.presetAnswer || "";

  $("tier-keywords").value = options.tierKeywords || "Ultimate,Diamond,Gold,VIP,Floor,2099";

  $("auto-consent").checked = options.autoConsent !== false;

  $("skip-obstructed").checked = options.skipObstructed !== false;

  $("skip-wheelchair").checked = options.skipWheelchair !== false;

  $("diagnostics").checked = options.diagnostics !== false;

  $("dual-tab").checked = options.dualTab !== false;

  $("notify-select").checked = options.notifyOnSelect !== false;

  $("sound-alert").checked = options.soundAlert !== false;

  $("anti-block").checked = options.antiBlock !== false;

  $("auto-collection").checked = options.autoCollection !== false;

  $("collection-method").value = options.collectionMethod || "qr";

  $("rotate-sessions").checked = options.rotateSessions !== false;

  $("tier-fallback").checked = options.tierFallback !== false;

  $("api-radar").checked = options.apiRadar !== false;

  $("api-stop-queue").checked = options.apiStopInQueue !== false;

  $("select-turbo").checked = options.selectTurbo !== false;

}



function renderLog(logs) {

  const list = $("activity-log");

  if (!logs?.length) {

    list.innerHTML = '<li class="empty">No activity yet.</li>';

    return;

  }

  list.innerHTML = logs.slice(-14).map((line) => `<li>${line}</li>`).join("");

}



function render(state) {

  if (!state) return;

  const runtime = state.runtime || {};

  const running = Boolean(runtime.running);



  $("live-pill").textContent = running ? "BOT ON" : "STANDBY";

  $("live-pill").className = `pill${running ? " live" : ""}`;



  const plat = state.options?.platform === "kktix" ? "KKTIX" : "HKTicketing";

  $("platform-label").textContent = runtime.connected ? `${plat} · connected` : plat;



  $("page-title").textContent = runtime.hkt?.stageLabel

    ? `Stage: ${runtime.hkt.stageLabel}`

    : runtime.pageTitle || "Open the event page on the live site.";



  $("status-message").textContent = runtime.message || "Ready.";



  $("start-live-f2").disabled = running;

  $("start-live-f1").disabled = running;

  $("stop-live").disabled = !running;



  renderLog(runtime.logs);

}



async function hydrate() {

  const result = await send("TICKPILOT_GET");

  if (!result?.ok) return;

  writeOptionsToForm(result.state.options);

  render(result.state);

}



function saveOptions() {

  send("TICKPILOT_SAVE_OPTIONS", { options: readOptionsFromForm() });

}



$("check-page").addEventListener("click", async () => {

  const options = readOptionsFromForm();

  await send("TICKPILOT_SAVE_OPTIONS", { options });

  const result = await send("TICKPILOT_CHECK_PAGE", { options });

  if (result?.ok) render(result.state);

  else if (result?.error) $("status-message").textContent = result.error;

});



$("test-alert").addEventListener("click", async () => {

  await send("TICKPILOT_TEST_ALERT");

  $("status-message").textContent = "Test notification sent — allow notifications if blocked.";

});



$("start-live-f2").addEventListener("click", async () => {

  const options = { ...readOptionsFromForm(), function2Enabled: true, function1Enabled: false };

  await send("TICKPILOT_SAVE_OPTIONS", { options });

  const result = await send("TICKPILOT_START_LIVE", { options, mode: "function2" });

  if (result?.ok) render(result.state);

});



$("start-live-f1").addEventListener("click", async () => {

  const options = { ...readOptionsFromForm(), function1Enabled: true, function2Enabled: false };

  await send("TICKPILOT_SAVE_OPTIONS", { options });

  const result = await send("TICKPILOT_START_LIVE", { options, mode: "function1" });

  if (result?.ok) render(result.state);

});



$("stop-live").addEventListener("click", async () => {

  const result = await send("TICKPILOT_STOP");

  if (result?.ok) render(result.state);

});



$("clear-log").addEventListener("click", async () => {

  const result = await send("TICKPILOT_CLEAR_LOG");

  if (result?.ok) render(result.state);

});



document.querySelectorAll("input, select").forEach((el) => {

  el.addEventListener("change", saveOptions);

});



chrome.storage.onChanged.addListener((changes, area) => {

  if (area === "local" && changes.tickpilot) render(changes.tickpilot.newValue);

});



hydrate();


