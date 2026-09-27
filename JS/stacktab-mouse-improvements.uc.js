// ==UserScript==
// @name           stacktab-mouse-improvements.uc.js
// @description    Stack tab improvements: middle-click new tab
// @include        main
// ==/UserScript==

(function () {
  // The `tab-group[data-floorp-stack]` a stack strip belongs to. The strip's
  // visual tabs carry `data-floorp-drag-id`; the matching real <tab> carries
  // `data-floorp-tab-id` with the same value — resolve one and climb to its
  // group. Robust even if the selected tab is in a different stack.
  function stackGroupFromStrip(strip) {
    const vTab = strip.querySelector?.(".floorp-stack-tab[data-floorp-drag-id]");
    if (!vTab) return null;
    const id = vTab.getAttribute("data-floorp-drag-id");
    const real = gBrowser.tabs.find(
      t => t.getAttribute("data-floorp-tab-id") === id
    );
    return real?.closest?.("tab-group[data-floorp-stack]") || real?.group || null;
  }

  const groupOf = (tab) =>
    tab?.closest?.("tab-group[data-floorp-stack]") || tab?.group || null;

  // Focus the address bar after opening a blank tab, like native new-tab does
  // (our explicit opens / Floorp's in-stack open don't). Deferred so it runs
  // after the tab switch settles.
  const focusUrlbar = () => {
    try { const u = window.gURLBar; if (u) { u.focus(); u.select?.(); } } catch (e) {}
  };

  // Move an already-open tab into `group`, landing at the stack's end. The
  // group-adoption API is version-specific, so try known shapes and report
  // which one worked (or none, so breakage is easy to localize).
  function adoptToStackEnd(tab, group) {
    try {
      if (typeof group.addTabs === "function") {
        group.addTabs([tab]); return "group.addTabs";
      }
      if (typeof gBrowser.moveTabToGroup === "function") {
        gBrowser.moveTabToGroup(tab, group); return "gBrowser.moveTabToGroup";
      }
      if (typeof gBrowser.addTabToGroup === "function") {
        gBrowser.addTabToGroup(group, tab); return "gBrowser.addTabToGroup";
      }
    } catch (err) {
      console.warn("[stack-mc] adopt error", err);
      return "error";
    }
    console.warn("[stack-mc] no group-adopt API found; tab left outside stack");
    return "none";
  }

  function init() {
    // ---- click: middle-click on the blank global tab-bar area ----
    // (Floorp itself handles middle-click-to-close and right-click on stack
    // tabs.)
    window.addEventListener("click", function (e) {
      const stackTab = e.target.closest?.(".floorp-stack-tab");

      // --- regular blank tab-bar area: new tab at GLOBAL END + focus it ---
      if (e.button === 1
          && !e.target.closest?.("#floorp-stack-items")
          && !stackTab
          && !e.target.closest?.(".tabbrowser-tab")) {
        const isScrollbox =
          e.target.classList?.contains("tabbrowser-arrowscrollbox") ||
          e.target.localName === "arrowscrollbox" ||
          e.target.id === "tabbrowser-arrowscrollbox" ||
          e.target.getAttribute?.("anonid") === "arrowscrollbox";
        if (!isScrollbox) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const newTab = gBrowser.addTab("about:newtab", {
          index: gBrowser.tabs.length,
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
        gBrowser.selectedTab = newTab;
        setTimeout(focusUrlbar, 0);
        return;
      }
    }, true);

    // ---- auxclick: stack strip blank area → new tab INSIDE the clicked stack,
    //      respecting the tab-opening-behavior pref ----
    // `cmd_newNavigatorTab` (Ctrl+T / +) only keeps the new tab in the stack
    // when the pref is "insert next to current"; with "default"/"at the end"
    // Firefox appends it at the GLOBAL end, outside the group. So we use the
    // native command only for the next-to-current case (where it lands right),
    // and otherwise open a tab explicitly and adopt it into the clicked stack's
    // group at the stack's end.
    window.addEventListener("auxclick", function (e) {
      if (e.button !== 1) return;
      if (e.target.closest?.(".floorp-stack-tab")) return; // Floorp closes it
      const stackBlank = e.target.closest?.("#floorp-stack-items");
      if (!stackBlank) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      const nativeNewTab = () => {
        document.getElementById("cmd_newNavigatorTab").doCommand();
        setTimeout(focusUrlbar, 0);
      };

      const group = stackGroupFromStrip(stackBlank);
      const afterCurrent =
        Services.prefs.getBoolPref("browser.tabs.insertAfterCurrent", false);

      // Next-to-current pref AND the selected tab is in the clicked stack →
      // the native command already inserts after current, inside the stack.
      if (afterCurrent && group && groupOf(gBrowser.selectedTab) === group) {
        nativeNewTab();
        return;
      }

      // Couldn't resolve the clicked stack → fall back to native behavior.
      if (!group) {
        nativeNewTab();
        return;
      }

      // Default / at-the-end (or selection is in a different stack): open a tab
      // and adopt it into the clicked stack, at the stack's end.
      const newTab = gBrowser.addTab("about:newtab", {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      const how = adoptToStackEnd(newTab, group);
      gBrowser.selectedTab = newTab; // foreground, like Ctrl+T / the + button
      setTimeout(focusUrlbar, 0);    // focus the address bar, like native new-tab
      console.log("[stack-mc] new in-stack tab via", how);
    }, true);

    console.log("[stack-mc] loaded");
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