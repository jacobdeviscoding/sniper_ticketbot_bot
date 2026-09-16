/**
 * Dispatch a pointer + mouse event sequence on a DOM element.
 * The click point is offset randomly inside the element, and delays
 * between hover / down / up are jittered so the timing is not identical
 * on every call.
 *
 * Synthetic events have event.isTrusted === false. Sites that require a
 * real user gesture will not treat this as a hardware click.
 */
(function attachHumanClick(global) {
  const DEFAULTS = {
    paddingRatio: 0.15,
    hoverDelay: [40, 120],
    downDelay: [30, 90],
    moveJitter: 2,
  };

  function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function randomInt(min, max) {
    return Math.floor(randomBetween(min, max + 1));
  }

  function isVisible(element) {
    const style = global.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function pickPoint(rect, paddingRatio) {
    const padX = rect.width * paddingRatio;
    const padY = rect.height * paddingRatio;
    const innerWidth = Math.max(1, rect.width - padX * 2);
    const innerHeight = Math.max(1, rect.height - padY * 2);
    return {
      clientX: rect.left + padX + Math.random() * innerWidth,
      clientY: rect.top + padY + Math.random() * innerHeight,
    };
  }

  function eventInit(point, extra) {
    return Object.assign(
      {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: global,
        clientX: point.clientX,
        clientY: point.clientY,
        screenX: point.clientX + (global.screenX || 0),
        screenY: point.clientY + (global.screenY || 0),
        button: 0,
        buttons: extra && extra.buttons !== undefined ? extra.buttons : 0,
        detail: extra && extra.detail !== undefined ? extra.detail : 0,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        width: 1,
        height: 1,
      },
      extra || {},
    );
  }

  function dispatch(element, EventCtor, type, point, extra) {
    const event = new EventCtor(type, eventInit(point, extra));
    element.dispatchEvent(event);
    return event;
  }

  /**
   * @param {Element} element
   * @param {object} [options]
   * @param {number} [options.paddingRatio]
   * @param {[number, number]} [options.hoverDelay]
   * @param {[number, number]} [options.downDelay]
   * @param {number} [options.moveJitter]
   * @returns {Promise<{ clientX: number, clientY: number }>}
   */
  async function humanClick(element, options) {
    if (!(element instanceof Element)) {
      throw new TypeError("humanClick(element) expects a DOM Element.");
    }
    if (!element.isConnected) {
      throw new Error("Element is not attached to the document.");
    }

    const settings = Object.assign({}, DEFAULTS, options || {});
    element.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });

    if (!isVisible(element)) {
      throw new Error("Element is not visible.");
    }

    const start = pickPoint(element.getBoundingClientRect(), settings.paddingRatio);
    const jitter = settings.moveJitter;
    const downPoint = {
      clientX: start.clientX + randomBetween(-jitter, jitter),
      clientY: start.clientY + randomBetween(-jitter, jitter),
    };

    dispatch(element, PointerEvent, "pointerover", start, { buttons: 0 });
    dispatch(element, MouseEvent, "mouseover", start, { buttons: 0 });
    dispatch(element, MouseEvent, "mouseenter", start, { bubbles: false, buttons: 0 });
    dispatch(element, PointerEvent, "pointermove", start, { buttons: 0 });
    dispatch(element, MouseEvent, "mousemove", start, { buttons: 0 });

    await sleep(randomInt(settings.hoverDelay[0], settings.hoverDelay[1]));

    dispatch(element, PointerEvent, "pointermove", downPoint, { buttons: 0 });
    dispatch(element, MouseEvent, "mousemove", downPoint, { buttons: 0 });
    dispatch(element, PointerEvent, "pointerdown", downPoint, { buttons: 1 });
    dispatch(element, MouseEvent, "mousedown", downPoint, { buttons: 1 });

    if (typeof element.focus === "function") {
      element.focus({ preventScroll: true });
    }

    await sleep(randomInt(settings.downDelay[0], settings.downDelay[1]));

    dispatch(element, PointerEvent, "pointerup", downPoint, { buttons: 0 });
    dispatch(element, MouseEvent, "mouseup", downPoint, { buttons: 0 });
    dispatch(element, MouseEvent, "click", downPoint, { buttons: 0, detail: 1 });

    return downPoint;
  }

  global.humanClick = humanClick;
})(typeof window !== "undefined" ? window : self);
