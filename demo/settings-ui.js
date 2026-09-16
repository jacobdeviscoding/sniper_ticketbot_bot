/** TechTickBot-style settings card below navbar (mirror only) */
(function initSettingsCard() {
  const card = document.createElement("section");
  card.id = "tickpilot-settings-card";
  card.className = "tp-settings-card";
  card.innerHTML = `
    <div class="tp-settings-head">
      <strong>TickPilot 設定</strong>
      <span id="tp-bot-badge" class="tp-bot-badge hidden">BOT</span>
    </div>
    <div class="tp-settings-grid">
      <label>會員號碼 <input id="tp-member" type="text" /></label>
      <label>預設答案 <input id="tp-answer" type="text" /></label>
      <label>場次 (1=第一場) <input id="tp-session-idx" type="number" min="1" max="9" /></label>
      <label>票區範圍 <input id="tp-zone" type="text" placeholder="1-3" /></label>
      <label>數量 <input id="tp-qty" type="number" min="1" max="10" /></label>
      <label>KKTIX 票價序 <input id="tp-kktix-price" type="number" min="1" max="9" /></label>
    </div>
    <div class="tp-settings-toggles">
      <label><input id="tp-consent" type="checkbox" /> 自動同意條款</label>
      <label><input id="tp-f1" type="checkbox" /> 功能一：重試同價</label>
      <label><input id="tp-f2" type="checkbox" /> 功能二：智能搶票</label>
      <label><input id="tp-skip-obs" type="checkbox" /> 跳過視線受阻</label>
      <label><input id="tp-skip-wc" type="checkbox" /> 跳過輪椅位</label>
    </div>
    <div class="tp-settings-actions">
      <button type="button" id="tp-start-f2" class="tp-green">Start Function 2</button>
      <button type="button" id="tp-start-f1">Function 1</button>
    </div>
  `;

  const header = document.querySelector(".hkt-header");
  if (header) header.after(card);

  function readCard() {
    return {
      memberNumber: card.querySelector("#tp-member").value.trim(),
      presetAnswer: card.querySelector("#tp-answer").value.trim(),
      sessionIndex: Number(card.querySelector("#tp-session-idx").value) || 1,
      zoneRange: card.querySelector("#tp-zone").value.trim() || "1-3",
      quantity: Number(card.querySelector("#tp-qty").value) || 2,
      kktixPriceIndex: Number(card.querySelector("#tp-kktix-price").value) || 2,
      autoConsent: card.querySelector("#tp-consent").checked,
      function1Enabled: card.querySelector("#tp-f1").checked,
      function2Enabled: card.querySelector("#tp-f2").checked,
      skipObstructed: card.querySelector("#tp-skip-obs").checked,
      skipWheelchair: card.querySelector("#tp-skip-wc").checked,
    };
  }

  function writeCard(options) {
    if (!options) return;
    card.querySelector("#tp-member").value = options.memberNumber || "";
    card.querySelector("#tp-answer").value = options.presetAnswer || "";
    card.querySelector("#tp-session-idx").value = options.sessionIndex ?? 1;
    card.querySelector("#tp-zone").value = options.zoneRange || "1-3";
    card.querySelector("#tp-qty").value = options.quantity ?? 2;
    card.querySelector("#tp-kktix-price").value = options.kktixPriceIndex ?? 2;
    card.querySelector("#tp-consent").checked = options.autoConsent !== false;
    card.querySelector("#tp-f1").checked = Boolean(options.function1Enabled);
    card.querySelector("#tp-f2").checked = options.function2Enabled !== false;
    card.querySelector("#tp-skip-obs").checked = options.skipObstructed !== false;
    card.querySelector("#tp-skip-wc").checked = options.skipWheelchair !== false;
  }

  function setBotBadge(on) {
    card.querySelector("#tp-bot-badge").classList.toggle("hidden", !on);
    document.body.classList.toggle("tp-bot-active", on);
  }

  async function syncFromExtension() {
    if (!chrome?.runtime?.sendMessage) return;
    const result = await chrome.runtime.sendMessage({ type: "TICKPILOT_GET" });
    if (result?.ok) {
      writeCard(result.state.options);
      setBotBadge(result.state.runtime?.running || result.state.runtime?.botActive);
    }
  }

  async function saveAndStart(mode) {
    const partial = readCard();
    if (chrome?.runtime?.sendMessage) {
      await chrome.runtime.sendMessage({ type: "TICKPILOT_SAVE_OPTIONS", options: partial });
      await chrome.runtime.sendMessage({
        type: "TICKPILOT_START",
        mode,
        options: {
          ...partial,
          function1Enabled: mode === "function1",
          function2Enabled: mode === "function2",
        },
      });
    } else if (window.HKTRunner) {
      window.HKTRunner.start({ ...partial, function2Enabled: mode === "function2", function1Enabled: mode === "function1" });
    }
    setBotBadge(true);
  }

  card.querySelector("#tp-start-f2").addEventListener("click", () => saveAndStart("function2"));
  card.querySelector("#tp-start-f1").addEventListener("click", () => saveAndStart("function1"));
  card.querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", () => {
      if (chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: "TICKPILOT_SAVE_OPTIONS", options: readCard() });
      }
    });
  });

  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.tickpilot) {
        writeCard(changes.tickpilot.newValue?.options);
        setBotBadge(changes.tickpilot.newValue?.runtime?.running);
      }
    });
  }

  syncFromExtension();
  window.TPSettings = { readCard, writeCard, setBotBadge };
})();
