// ==UserScript==
// @name           stacktab-close-last-becomes-newtab.uc.js
// @description    Stack: closing the LAST tab becomes a new-tab page (not stack close)
// @include        main
// ==/UserScript==

// Mirrors Floorp's window-level behavior — closing the last tab in a window loads
// about:newtab instead of closing the window — for STACKS: closing the last tab in
// a `tab-group[data-floorp-stack]` keeps the stack alive with a fresh about:newtab
// instead of dissolving it. Closing the WHOLE stack (its X / middle-click) is left
// alone. STACKS ONLY — plain Firefox tab groups still dissolve on their last tab.
//
// HOW: just before the last stack tab is removed, drop a fresh about:newtab into
// the same stack, then let the native gBrowser.removeTab close the original tab.
// The stack survives because the replacement is already a member, and closing the
// original through Firefox's normal path gives it a proper recently-closed entry —
// Ctrl+Shift+T reopens it, back into the stack, with full history and correct
// (newest-first) order.
//
// CHOKEPOINT — wrap gBrowser.removeTab, the single funnel for every one-tab close
// (middle-click, Ctrl+W, close button, context menu). No other script wraps
// removeTab, so this is collision-free and load-order-independent.
//
// BULK GUARD — a whole-stack close also reaches removeTab via
// removeTabGroup(group) -> removeTabs(tabs) -> removeTab(tab). A `bulk` counter
// (raised while those run) and a call-stack check suppress the replacement during
// any multi-tab removal, so only a genuine lone close of the last stack tab is
// handled. Composes with the confirm script (also wraps removeTabGroup) either way.

(function () {
  const SYS = () => Services.scriptSecurityManager.getSystemPrincipal();

  // The stack group a tab belongs to, or null. STACKS ONLY — plain Firefox tab
  // groups (the user's tier-2 fixed groups) are intentionally excluded.
  const stackOf = (tab) => tab?.closest?.("tab-group[data-floorp-stack]") || null;

  // Would `tab` be the last surviving tab in `group`? (Ignore tabs already
  // animating closed; `tab` itself isn't marked closing yet at intercept time.)
  function isLastInStack(tab, group) {
    let list = null;
    try {
      if (group.tabs && group.tabs.length != null) list = Array.from(group.tabs);
    } catch (e) { /* fall through to DOM scan */ }
    if (!list) {
      list = gBrowser.tabs.filter(
        t => t.closest?.("tab-group[data-floorp-stack]") === group
      );
    }
    return list.filter(t => t !== tab && !t.closing).length === 0;
  }

  // Focus the address bar for the replacement tab (matches opening a new tab), but
  // only when we actually switched to it.
  function maybeFocusUrlbar(tab) {
    if (gBrowser.selectedTab !== tab) return;
    setTimeout(() => {
      try { const u = window.gURLBar; if (u) { u.focus(); u.select?.(); } } catch (e) {}
    }, 0);
  }

  function init() {
    // ---- bulk guard: don't add a replacement during a group/multi-tab removal ----
    let bulk = 0;
    const guardBulk = (name) => {
      const orig = gBrowser[name];
      if (typeof orig !== "function") return false;
      gBrowser[name] = function (...args) {
        bulk++;
        try { return orig.apply(this, args); }
        finally { bulk--; }
      };
      return true;
    };
    const wrappedGroup = guardBulk("removeTabGroup");
    const wrappedTabs  = guardBulk("removeTabs");

    // Backup discriminator if minification hides the wrappers above: a bulk-removal
    // frame on the call stack means we're inside a multi-tab close.
    const inBulkStack = () => {
      try {
        const s = new Error().stack || "";
        return /removeTabGroup|removeTabs|removeAllTabs/.test(s);
      } catch (e) { return false; }
    };

    const origRemoveTab = gBrowser.removeTab;

    // Make `tab` a live member of `group` at the stack's end. Group-adoption API is
    // version-specific; try known shapes. Returns true if it joined.
    function adoptToGroup(tab, group) {
      try {
        if (typeof group.addTabs === "function") { group.addTabs([tab]); return true; }
        if (typeof gBrowser.moveTabToGroup === "function") { gBrowser.moveTabToGroup(tab, group); return true; }
        if (typeof gBrowser.addTabToGroup === "function") { gBrowser.addTabToGroup(group, tab); return true; }
      } catch (e) { console.warn("[stack-lasttab] adopt-to-group error", e); return false; }
      return false;
    }

    // Drop a fresh about:newtab into `group` so the stack survives the imminent
    // native close of `tab`. If `tab` was selected, foreground the replacement so
    // closing `tab` doesn't flash its content. Returns true if a replacement is in
    // place (proceed with the native close), false to fall back to a plain removal.
    function placeReplacement(tab, group) {
      const wasSelected = gBrowser.selectedTab === tab;
      let newTab = null;
      try {
        newTab = gBrowser.addTab("about:newtab", { triggeringPrincipal: SYS() });
        if (!newTab) return false;
        if (!adoptToGroup(newTab, group)) {
          // Couldn't join the stack — remove the replacement rather than leave a
          // stray global tab, and let the close fall through to native.
          origRemoveTab.call(gBrowser, newTab, { animate: false });
          console.warn("[stack-lasttab] no group-adopt API; replacement removed, closing natively");
          return false;
        }
        if (wasSelected) {
          gBrowser.selectedTab = newTab;   // foreground so closing `tab` doesn't flash
          maybeFocusUrlbar(newTab);
        }
        return true;
      } catch (e) {
        console.warn("[stack-lasttab] could not place replacement newtab", e);
        try { if (newTab && !newTab.closing) origRemoveTab.call(gBrowser, newTab, { animate: false }); } catch (e2) {}
        return false;
      }
    }

    // ---- the intercept ----
    gBrowser.removeTab = function (tab, options) {
      try {
        if (bulk === 0 && tab && !tab.pinned && !tab.closing) {
          const group = stackOf(tab);
          if (group && isLastInStack(tab, group) && !inBulkStack()) {
            // Keep the stack alive with a replacement, then fall through so the
            // native removal closes `tab` for real (proper recently-closed entry).
            if (placeReplacement(tab, group)) {
              console.log("[stack-lasttab] last tab in stack → placed replacement new-tab; closing original natively");
            }
          }
        }
      } catch (e) {
        console.warn("[stack-lasttab] guard error, removing normally", e);
      }
      return origRemoveTab.call(this, tab, options);
    };

    console.log(
      "[stack-lasttab] loaded (replacement-tab + native close; bulk guard: " +
      (wrappedGroup ? "removeTabGroup " : "") +
      (wrappedTabs ? "removeTabs " : "") + "+ stack-scan)"
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
