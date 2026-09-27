// ==UserScript==
// @name           stacktab-hotkey-opens-in-stack.uc.js
// @description    New-tab NON-SPATIAL triggers (Ctrl+T + gesture) open in stack
// @include        main
// ==/UserScript==

// Makes NON-SPATIAL new-tab triggers open INSIDE the current stack when the
// selected tab is in one, like the stack-blank middle-click. "Non-spatial" =
// triggers with no on-screen location: the KEYBOARD shortcut (Ctrl+T) and the
// mouse GESTURE. SPATIAL triggers — the `+` button and the right-click "New
// Tab" menu — are deliberately left global (each stack has its own inline `+`,
// see stacktab-inline-newtab-button.uc.js).
//
// HOW WE OPEN IN-STACK: by clicking the stack's own `+` (`#floorp-stack-newtab`),
// i.e. Floorp's NATIVE in-stack opener (`addTabToActiveGroup`, stack-bar.tsx).
// An earlier version instead CREATED a global tab and then MOVED it into the
// group (`adoptToStackEnd` → moveTabToGroup / group.addTabs). That worked, but
// the move is seen by Floorp as a structural change and replays the stack's
// "roll the second row down" expand animation every time — whereas a tab BORN
// in the group (what the `+` button does) doesn't. So we now reuse the `+`
// button's exact path and get the clean, animation-free open for free. This is
// also more in the spirit of "work WITH Floorp's mechanisms". `adoptToStackEnd`
// stays only as a FALLBACK for when the button can't be found/clicked.
//
// WHY TWO HOOKS FOR ONE BEHAVIOR (the architecture, confirmed by TabOpen
// console.trace, §6): every new-tab path eventually funnels through Floorp's
// bundled `openTab` (index.ts:204) → openLinkIn → gBrowser.addTab. Tempting to
// patch that one shared function — but at that layer the keyboard and the `+`
// button are INDISTINGUISHABLE. What separates them is the command ELEMENT one
// layer up (`cmd_newNavigatorTabNoEvent` for keys vs `cmd_newNavigatorTab` for
// the button); by `openTab` that's gone. So the keyboard MUST be caught at the
// command layer to keep the button global. The two non-spatial triggers reach
// their shared behavior differently:
//
//   KEYBOARD → fires the `cmd_newNavigatorTabNoEvent` COMMAND. We intercept the
//     DOM `command` event in capture phase, cancel it, and click the stack `+`.
//
//   GESTURE  → does NOT fire a command at all: handleMouseUp → executeGesture-
//     Action → openTab → gBrowser.addTab. Invisible to the command hook, but
//     `executeGestureAction` sits in its call stack and nobody else's, so it IS
//     separable at the shared `addTab` layer. We wrap `gBrowser.addTab`; when a
//     blank-URL add comes from a gesture while in a stack, we click the stack
//     `+` instead, find whichever tab that opened, and hand THAT tab back to
//     openTab (so no global tab is created). A re-entry guard stops the button's
//     own addTab from recursing.
//
// Both hooks share the SAME decision (`targetStack`) and the SAME
// `openInActiveStackButton()` helper, so their behavior can't drift.
//
// Respects the tab-opening-behavior pref:
//   - insert next to current → let it run natively (already inserts after the
//                              current tab, inside the stack).
//   - default / open at end   → would append at the GLOBAL end (out of the
//                              stack); redirect into the current stack.
// When the selected tab is NOT in a Floorp stack, nothing changes.

(function () {
  const CMD_IDS = new Set(["cmd_newNavigatorTabNoEvent"]);
  const LOG = "[newtab-instack]";

  const SYS = () => Services.scriptSecurityManager.getSystemPrincipal();

  // Native new-tab focuses the address bar so you can type immediately; the
  // stack `+`/adopt paths don't always, so restore it (deferred to run after
  // the tab switch settles).
  const focusUrlbar = () => {
    try { const u = window.gURLBar; if (u) { u.focus(); u.select?.(); } } catch (e) {}
  };

  // Only Floorp STACKS (tab-group[data-floorp-stack]); plain Firefox tab groups
  // are intentionally excluded so their new-tab behavior is left native.
  const stackOf = (tab) =>
    tab?.closest?.("tab-group[data-floorp-stack]") || null;

  // The shared decision: should a new tab from a non-spatial trigger be routed
  // into the current stack? Only when the selected tab is in a stack AND the
  // pref isn't already "insert next to current" (which keeps it in-stack for
  // free). Returns the stack group, or null to leave native.
  function targetStack() {
    const group = stackOf(gBrowser.selectedTab);
    const afterCurrent =
      Services.prefs.getBoolPref("browser.tabs.insertAfterCurrent", false);
    return group && !afterCurrent ? group : null;
  }

  // FALLBACK only: move an already-open tab into `group` at the stack's end.
  // Group-adoption API is version-specific — try known shapes. This is the path
  // that replays the roll-down animation, so it's used only when the `+` button
  // route is unavailable.
  function adoptToStackEnd(tab, group) {
    try {
      if (typeof group.addTabs === "function") { group.addTabs([tab]); return "group.addTabs"; }
      if (typeof gBrowser.moveTabToGroup === "function") { gBrowser.moveTabToGroup(tab, group); return "gBrowser.moveTabToGroup"; }
      if (typeof gBrowser.addTabToGroup === "function") { gBrowser.addTabToGroup(group, tab); return "gBrowser.addTabToGroup"; }
    } catch (err) { console.warn(LOG, "adopt error", err); return "error"; }
    console.warn(LOG, "no group-adopt API found; tab left outside stack");
    return "none";
  }

  function isNewTabCommand(t) {
    if (!t) return false;
    const ref = t.getAttribute?.("command") || t.getAttribute?.("observes");
    return CMD_IDS.has(t.id) || CMD_IDS.has(ref);
  }

  function init() {
    // Re-entry guard: while WE are clicking the stack `+`, the button's own
    // addTabToActiveGroup calls gBrowser.addTab — and `executeGestureAction` may
    // still be on the stack, so without this flag the gesture wrap would recurse.
    let clicking = false;

    // Open a tab in the ACTIVE stack via Floorp's native `+` button (no roll-down
    // animation). Returns the newly-opened tab, or null if the button wasn't
    // available / opened nothing. Finds the new tab by diffing the tab list, so
    // it's robust whether the button foregrounds it or not.
    function openInActiveStackButton() {
      const btn = document.getElementById("floorp-stack-newtab");
      if (!btn || !btn.isConnected) return null;
      const before = new Set(gBrowser.tabs);
      clicking = true;
      try { btn.click(); }
      catch (err) { console.warn(LOG, "stack + click error", err); }
      finally { clicking = false; }
      return gBrowser.tabs.find((t) => !before.has(t)) || null;
    }

    // ---- KEYBOARD: cancel the command, click the stack `+` ----
    let handledThisTick = false;

    function tryOpenInStack() {
      const group = targetStack();
      if (!group) return false; // native handles the rest

      if (handledThisTick) return true; // duplicate within the same action
      handledThisTick = true;
      setTimeout(() => { handledThisTick = false; }, 0);

      const opened = openInActiveStackButton();
      if (opened) {
        setTimeout(focusUrlbar, 0);
        console.log(LOG, "keyboard → current stack via + button");
        return true;
      }

      // Fallback (button missing): create + adopt (this one animates).
      const newTab = gBrowser.addTab("about:newtab", { triggeringPrincipal: SYS() });
      const how = adoptToStackEnd(newTab, group);
      gBrowser.selectedTab = newTab;
      setTimeout(focusUrlbar, 0);
      console.log(LOG, "keyboard → current stack via", how, "(fallback)");
      return true;
    }

    window.addEventListener("command", function (e) {
      if (!isNewTabCommand(e.target)) return;
      if (tryOpenInStack()) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);

    // ---- GESTURE: swap the gesture's global open for a stack `+` open ----
    // The gesture calls gBrowser.addTab (via openTab → openLinkIn) with
    // `executeGestureAction` in the call stack. We wrap addTab; when a blank add
    // comes from a gesture while in a stack, we DON'T create the global tab —
    // instead we click the stack `+` and return the tab it opened, so openTab
    // proceeds with an already-in-stack tab and nothing needs relocating.
    const BLANK = new Set([
      "about:newtab", "about:home", "about:blank", "about:privatebrowsing",
    ]);
    const isBlank = (uri) => uri == null || uri === "" || BLANK.has(uri);
    const fromGesture = () => {
      try { return (new Error().stack || "").includes("executeGestureAction"); }
      catch (e) { return false; }
    };

    const origAddTab = gBrowser.addTab;
    if (typeof origAddTab === "function") {
      gBrowser.addTab = function (uri, ...rest) {
        // Inner call from our own `+` click → let it create normally (and don't
        // re-enter the gesture logic).
        if (clicking) return origAddTab.call(this, uri, ...rest);

        // Decide BEFORE creating anything: read the group while
        // `executeGestureAction` is still on the stack and `selectedTab` is still
        // the tab you were on (the gesture's own addTab would foreground the new
        // tab, hiding the stack from a later check).
        let group = null;
        try {
          if (isBlank(uri) && fromGesture()) group = targetStack();
        } catch (err) { console.warn(LOG, "gesture detect error", err); }

        if (group) {
          const opened = openInActiveStackButton();
          if (opened) {
            setTimeout(focusUrlbar, 0);
            console.log(LOG, "gesture → current stack via + button");
            return opened; // hand openTab the in-stack tab; no global tab made
          }
          // Fallback (button missing): let the gesture create its global tab,
          // then adopt it (this one animates, but it still lands in-stack).
          const tab = origAddTab.call(this, uri, ...rest);
          const how = adoptToStackEnd(tab, group);
          setTimeout(focusUrlbar, 0);
          console.log(LOG, "gesture → current stack via", how, "(fallback)");
          return tab;
        }

        return origAddTab.call(this, uri, ...rest);
      };
      console.log(LOG, "loaded (command hook + gesture addTab wrap, via stack +)");
    } else {
      console.warn(LOG, "gBrowser.addTab not a function; gesture hook skipped");
      console.log(LOG, "loaded (command hook only)");
    }
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
