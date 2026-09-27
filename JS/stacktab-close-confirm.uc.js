// ==UserScript==
// @name           stacktab-close-confirm.uc.js
// @description    Confirm before closing a tab stack / group (multi-tab warning)
// @include        main
// ==/UserScript==

// Closing a whole stack/group (via the X, middle-click, or the context menu)
// silently discards every tab in it. This adds the same confirmation you get
// when closing a window with multiple tabs, gated on the SAME pref as that
// setting — "Confirm before closing multiple tabs" (browser.tabs.warnOnClose).
// One tab → no prompt (matches the native multi-tab rule).
//
// We hook the close at the API layer (`gBrowser.removeTabGroup`) rather than at
// each button/menu, so every route that funnels through it is covered at once.
// If a given route (e.g. middle-click) turns out NOT to call removeTabGroup in
// your build, the `[stack-close]` logs will show it and we can add a targeted
// hook for that path.

(function () {
  const PREF = "browser.tabs.warnOnClose";

  // Number of open tabs the group would close.
  function tabCountOf(group) {
    try {
      if (group && group.tabs) return group.tabs.length;
    } catch (e) {}
    try {
      return gBrowser.tabs.filter(t => t.group === group).length;
    } catch (e) {}
    return 0;
  }

  // Returns true to proceed with the close, false to cancel.
  // Prefers the native multi-tab warning (localized, and its "don't ask again"
  // checkbox writes back to browser.tabs.warnOnClose — same as the settings
  // toggle). Falls back to a hand-rolled dialog gated on the same pref.
  function confirmCloseGroup(group) {
    const count = tabCountOf(group);
    if (count <= 1) return true; // single tab → never prompt, like native

    // --- native path ---
    try {
      if (typeof gBrowser.warnAboutClosingTabs === "function") {
        const type = gBrowser.closingTabsEnum
          ? gBrowser.closingTabsEnum.ALL
          : 0; // ALL → reads browser.tabs.warnOnClose
        return gBrowser.warnAboutClosingTabs(count, type);
      }
    } catch (e) {
      console.warn("[stack-close] warnAboutClosingTabs failed; using fallback", e);
    }

    // --- fallback path (same pref gate + "don't ask again") ---
    let shouldPrompt = true;
    try { shouldPrompt = Services.prefs.getBoolPref(PREF, true); } catch (e) {}
    if (!shouldPrompt) return true;

    try {
      const ps = Services.prompt;
      const flags =
        ps.BUTTON_TITLE_IS_STRING * ps.BUTTON_POS_0 +
        ps.BUTTON_TITLE_CANCEL   * ps.BUTTON_POS_1;
      const check = { value: true };
      const proceed = ps.confirmEx(
        window,
        "Confirm close",
        `You are about to close ${count} tabs. Are you sure you want to continue?`,
        flags,
        "Close tabs", null, null,
        "Confirm before closing multiple tabs",
        check
      ) === 0;
      // Honor the checkbox exactly like the native dialog does.
      if (proceed && !check.value) {
        try { Services.prefs.setBoolPref(PREF, false); } catch (e) {}
      }
      return proceed;
    } catch (e) {
      console.warn("[stack-close] fallback prompt failed; allowing close", e);
      return true; // never trap the user's close on our own error
    }
  }

  // Wrap a method so the group close is confirmed first. Idempotent, and a
  // no-op if the method doesn't exist in this build.
  function wrapClose(obj, name) {
    if (!obj || typeof obj[name] !== "function") return false;
    const FLAG = "__stackCloseWrapped_" + name;
    if (obj[FLAG]) return true;

    const orig = obj[name];
    const isAsync = orig.constructor && orig.constructor.name === "AsyncFunction";

    obj[name] = function (group, ...rest) {
      try {
        if (group && !confirmCloseGroup(group)) {
          console.log("[stack-close] close cancelled via", name);
          return isAsync ? Promise.resolve() : undefined;
        }
      } catch (e) {
        console.warn("[stack-close] confirm error; proceeding", e);
      }
      return orig.call(this, group, ...rest);
    };

    obj[FLAG] = true;
    return true;
  }

  function init() {
    const hooked = [];
    if (wrapClose(gBrowser, "removeTabGroup")) hooked.push("gBrowser.removeTabGroup");
    console.log(
      "[stack-close] loaded; hooked:",
      hooked.length ? hooked.join(", ") : "NOTHING (removeTabGroup not found)"
    );
  }

  if (gBrowserInit && gBrowserInit.delayedStartupFinished) {
    init();
  } else {
    const obs = (subject) => {
      if (subject === window) {
        Services.obs.removeObserver(obs, "browser-delayed-startup-finished");
        init();
      }
    };
    Services.obs.addObserver(obs, "browser-delayed-startup-finished");
  }
})();
