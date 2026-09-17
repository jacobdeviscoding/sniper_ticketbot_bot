/**
 * HKT / iMaiTix stock radar — rest-sig.imaitix.com
 *
 * iMaiTix is a closed enterprise backend (Damai / regional white-label). There is
 * no public open API for queue control, sale conversion, or cart bypass. Vendor
 * REST keys are provisioned only to promoters under contract.
 *
 * TickPilot uses the same read-only GET endpoints the HKT SPA calls while you are
 * logged in (session cookies + referer). We never POST cart/checkout or manipulate
 * sale state. This gives stock truth and faster tier pick AFTER queue — not queue skip.
 */
const HktApi = (() => {
  const API_BASE = "https://rest-sig.imaitix.com/api";

  function langTypeFromLocale(locale) {
    return locale === "zh" || locale === "zh-HK" ? 1 : 2;
  }

  function getProjectToken(fallback) {
    if (typeof getProjectIdFromUrl === "function") {
      return getProjectIdFromUrl(location.href) || fallback || "";
    }
    return fallback || "";
  }

  async function fetchJson(url) {
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const json = await res.json();
    if (String(json.code) !== "200") throw new Error(`API code ${json.code}`);
    return json;
  }

  async function fetchProject(projectToken, langType = 2) {
    const url =
      `${API_BASE}/pro/project?projectToken=${encodeURIComponent(projectToken)}` +
      `&reqType=1&langType=${langType}`;
    return fetchJson(url);
  }

  async function fetchEvent(eventToken, langType = 2) {
    const url =
      `${API_BASE}/pro/event?eventToken=${encodeURIComponent(eventToken)}` +
      `&langType=${langType}`;
    return fetchJson(url);
  }

  function normalizePriceVo(p) {
    return {
      priceId: p.priceId,
      price: parseFloat(String(p.price || "0").replace(/,/g, "")),
      name: p.priceName || "",
      sellOut: Boolean(p.sellOut),
      goodCount: Number(p.goodCount) || 0,
      canAddCart: Boolean(p.canAddCart),
      color: p.color || "",
    };
  }

  function normalizeEvent(ev) {
    const prices = (ev.priceVoList || []).map(normalizePriceVo);
    const inStock = prices.filter((p) => !p.sellOut && p.goodCount > 0);
    const maybeStock = prices.filter((p) => !p.sellOut);
    return {
      eventToken: ev.eventToken,
      caption: ev.eventCaption || ev.aliasName || "",
      aliasName: ev.aliasName || "",
      canAddCart: Boolean(ev.canAddCart),
      buttonState: ev.buttonState,
      eventSaleStage: ev.eventSaleStage,
      prices,
      inStock,
      maybeStock,
      hasStock: inStock.length > 0 || maybeStock.length > 0,
      allSoldOut: prices.length > 0 && prices.every((p) => p.sellOut || p.goodCount <= 0),
    };
  }

  function analyzeProject(json) {
    const root = json?.data || {};
    const events = (root.eventVoList || []).map(normalizeEvent);
    const summary = {
      projectToken: root.projectToken || null,
      aliasName: root.aliasName || "",
      canAddCart: Boolean(root.canAddCart),
      buttonState: root.buttonState,
      allowChooseSeat: root.allowChooseSeat,
      events,
      eventsWithStock: events.filter((e) => e.hasStock && !e.allSoldOut),
      fullySoldOut: events.length > 0 && events.every((e) => e.allSoldOut),
      totalInStockCount: events.reduce(
        (n, e) => n + e.inStock.reduce((s, p) => s + p.goodCount, 0),
        0,
      ),
      at: Date.now(),
    };
    return summary;
  }

  function priceMatchesFilters(p, opts) {
    if (p.sellOut || p.goodCount <= 0) return false;
    if (p.price < (opts.minPrice || 0)) return false;
    if (p.price > (opts.maxPrice || 100000)) return false;
    if (opts.skipObstructed !== false && /obstructed|視線受阻|视线受阻|部分视线/i.test(p.name)) {
      return false;
    }
    if (opts.skipWheelchair !== false && /wheelchair|輪椅|轮椅/i.test(p.name)) return false;
    const keys = String(opts.tierKeywords || "")
      .split(/[,，|]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (keys.length && opts.tierFallback === false) {
      const blob = `${p.name} ${p.price}`;
      if (!keys.some((k) => blob.includes(k) || (k === "2099" && /2099/.test(blob)))) {
        return false;
      }
    }
    return true;
  }

  function pickBestOffer(summary, opts) {
    if (!summary?.events?.length) return null;
    const highFirst = opts.preferHigherPrice !== false && (opts.minPrice || 0) >= 1000;
    let best = null;

    const eventOrder = [...summary.events];
    if (opts.sessionIndex) {
      const idx = Math.max(0, (opts.sessionIndex || 1) - 1);
      const rotated = [
        ...eventOrder.slice(idx),
        ...eventOrder.slice(0, idx),
      ];
      eventOrder.splice(0, eventOrder.length, ...rotated);
    }

    for (const ev of eventOrder) {
      if (ev.allSoldOut) continue;
      const pool = ev.inStock.length ? ev.inStock : ev.maybeStock.filter((p) => !p.sellOut);
      let candidates = pool.filter((p) => priceMatchesFilters(p, opts));
      if (!candidates.length && opts.tierFallback !== false) {
        candidates = pool.filter((p) => {
          if (p.sellOut || p.goodCount <= 0) return false;
          return p.price >= (opts.minPrice || 0) && p.price <= (opts.maxPrice || 100000);
        });
      }
      if (!candidates.length) continue;
      candidates.sort((a, b) => {
        if (highFirst && a.price !== b.price) return b.price - a.price;
        return b.goodCount - a.goodCount;
      });
      const pick = candidates[0];
      best = { event: ev, price: pick };
      break;
    }
    return best;
  }

  function sessionHintsFromEvent(ev) {
    const cap = ev.caption || "";
    const hints = [cap];
    const m = cap.match(/(\d{1,2}\s+\w+\s+\d{4})/i);
    if (m) hints.push(m[1]);
    const m2 = cap.match(/(\d{1,2}\s+Nov)/i);
    if (m2) hints.push(m2[1]);
    if (ev.aliasName) hints.push(ev.aliasName.slice(0, 20));
    return [...new Set(hints.filter(Boolean))];
  }

  function formatStockLine(summary) {
    if (!summary?.events?.length) return "API: no event data";
    if (summary.fullySoldOut) return "API: ALL SOLD OUT (every date/tier)";
    const parts = summary.events.map((e) => {
      const stockN = e.inStock.reduce((s, p) => s + p.goodCount, 0);
      const tierN = e.inStock.length || e.maybeStock.filter((p) => !p.sellOut).length;
      let tag = "SOLD OUT";
      if (!e.allSoldOut) {
        tag = stockN > 0 ? `${tierN} tier · ~${stockN} left` : `${tierN} tier(s)`;
      }
      const short = (e.caption || "").match(/\d{1,2}\s+\w+/i)?.[0] || e.caption?.slice(0, 12);
      return `${short}: ${tag}`;
    });
    const total = summary.totalInStockCount > 0 ? ` · ~${summary.totalInStockCount} total` : "";
    return `Radar · ${parts.join(" · ")}${total}`;
  }

  function formatBestOfferLine(offer) {
    if (!offer?.event || !offer?.price) return "";
    const date = (offer.event.caption || "").match(/\d{1,2}\s+\w+/i)?.[0] || "best date";
    const stock = offer.price.goodCount > 0 ? ` · ${offer.price.goodCount} left` : "";
    return `Target · ${date} · HK$${offer.price.price}${stock}`;
  }

  function tierDomScore(elText, apiPrice) {
    const text = String(elText || "");
    const price = apiPrice.price;
    let score = 0;
    const domPrice = parseFloat(String(text).replace(/[^\d.]/g, "")) || 0;
    if (domPrice === price) score += 100;
    if (text.includes(String(price))) score += 40;
    const nameKey = (apiPrice.name || "").split(/[/／]/)[0]?.trim();
    if (nameKey && nameKey.length >= 2 && text.includes(nameKey)) score += 60;
    return score;
  }

  return {
    langTypeFromLocale,
    getProjectToken,
    fetchProject,
    fetchEvent,
    analyzeProject,
    pickBestOffer,
    sessionHintsFromEvent,
    formatStockLine,
    formatBestOfferLine,
    tierDomScore,
    normalizeEvent,
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.HktApi = HktApi;
}
