// ==UserScript==
// @name           stacktab-general-fixes.uc.js
// @description    Stack tabs: general fixes
// @include        main
// ==/UserScript==

// Context menu text: when the browser starts on a stack tab, right-clicking a
// stack tab first opens the tab context menu with its entries' text missing
// (icons only). The menu's strings load lazily: Tabbrowser's
// translateTabContextMenu inserts tabContextMenu.ftl and turns the items'
// data-lazy-l10n-id into data-l10n-id the first time the pointer enters,
// right-clicks, or focuses #tabbrowser-tabs. Floorp's stack tabs live outside
// it, in the stack bar, which is only shown while a stack is active — so
// starting on a global tab always reaches the tab strip first, but starting
// on a stack tab can reach the stack bar first. Loading the strings at
// startup covers every entry point.
//
// Stacks missing in a new window: a window opened after startup (typically
// the second window of a restored session) can come up with its stacks as
// plain tab groups and no "Change to Tab Stack" option — the tab stacks
// feature never started there. Floorp starts its features from an async
// module script in browser.xhtml's <head> (nora-startup/chrome_root.js →
// core.js initScripts), which waits for SessionStore.promiseInitialized and
// then constructs each feature once. In the first window that promise
// resolves late, but in later windows it has already resolved, so the
// features can start before the window's chrome is built. TabStacks.init
// then finds no gBrowser / #navigator-toolbox / #nav-bar, logs "Browser
// chrome not ready; skipping tab stacks." and never retries.
// Once the chrome is ready, this imports Floorp's tab stacks module (the
// window's own instance, the one Floorp loaded) and, if stacks aren't running
// in this window, starts them. TabStacks.init is also made a no-op when they
// already are, so whichever of Floorp and this script comes second does
// nothing. "Running" is detected by the stack kind menu (#floorp-stack-kind-
// menu) that TabStacks.init adds to #mainPopupSet.

(function () {
  const LOG = "[stack-general-fixes]";

  // ---- Stacks missing in a new window ----
  const STACKS_PREF = "floorp.tabstacks.enabled";
  const STACKS_MARKER = "floorp-stack-kind-menu";
  const CORE_URL = "chrome://noraneko/content/core.js";

  const stacksRunning = () => !!document.getElementById(STACKS_MARKER);

  // Floorp's bundle names its chunks by number, which can change between
  // versions; core.js's module map gives the current one for tab-stacks.
  async function tabStacksModuleURL() {
    const core = await (await fetch(CORE_URL)).text();
    const match = core.match(
      /"\.\/tab-stacks\/index\.ts":\s*\(\)\s*=>\s*__vitePreload\(\(\)\s*=>\s*import\((['"])([^'"]+)\1\)/
    );
    return match ? new URL(match[2], CORE_URL).href : null;
  }

  async function ensureTabStacks() {
    if (!Services.prefs.getBoolPref(STACKS_PREF, false)) return;
    // Floorp starts its features only after this, too.
    await SessionStore.promiseInitialized;

    const url = await tabStacksModuleURL();
    if (!url) {
      console.warn(LOG, "couldn't find Floorp's tab stacks module in", CORE_URL);
      return;
    }
    const mod = await import(url);
    const TabStacks = mod.default;
    if (typeof TabStacks !== "function" || mod.ENABLED_PREF !== STACKS_PREF) {
      console.warn(LOG, "unexpected tab stacks module at", url);
      return;
    }

    const proto = TabStacks.prototype;
    if (!proto.ucStartOnce) {
      proto.ucStartOnce = true;
      const init = proto.init;
      proto.init = function () {
        if (stacksRunning()) return undefined;
        return init.call(this);
      };
    }

    if (!stacksRunning()) {
      console.warn(LOG, "tab stacks didn't start in this window; starting them");
      new TabStacks();
    }
  }

  function init() {
    gBrowser.translateTabContextMenu?.();
    ensureTabStacks().catch(e => console.error(LOG, "starting tab stacks:", e));
    console.log(LOG, "loaded");
  }

  if (gBrowserInit && gBrowserInit.delayedStartupFinished) init();
  else {
    const obs = (s) => {
      if (s === window) {
        Services.obs.removeObserver(obs, "browser-delayed-startup-finished");
        init();
      }
    };
    Services.obs.addObserver(obs, "browser-delayed-startup-finished");
  }
})();
