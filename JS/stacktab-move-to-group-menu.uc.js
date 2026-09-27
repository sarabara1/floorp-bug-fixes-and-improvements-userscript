// ==UserScript==
// @name           stacktab-move-to-group-menu.uc.js
// @description    Stack tab context menu: show "Add Tab to Group"
// @include        main
// ==/UserScript==

// Right-clicking a tab inside a stack shows the same menu as a global tab,
// except "Add Tab to Group" — Floorp hides that item (#context_moveTabToGroup)
// whenever the menu was opened from a stack strip tab. This puts it back, so a
// tab can go straight from a stack into another group/stack (or a new one)
// without first dragging it out to the global tabs.
//
// Order of the tabContextMenu `popupshowing` listeners:
//   1. Firefox (on the popup)     → decides whether the item should show.
//   2. us (on the popup, later)   → record that decision.
//   3. Floorp (on the document)   → hides it for stack tabs.
//   4. us (on the window)         → restore Firefox's decision.
// Restoring Firefox's decision (rather than forcing it visible) keeps its own
// rules intact, e.g. showing the simpler "Add Tab to New Group" instead when
// there's no other group to move to.
//
// The commands act on the right tab as-is: Floorp already points the menu at
// the real tab behind the strip tab.
//
// Placement: Firefox's "New Group" inserts the new group just BEFORE the
// group (or stack) the tab came from. We place it just AFTER that group
// instead, by swapping addTabGroup's `insertBefore` for whatever follows the
// group in the strip (the end, if nothing does). Ungrouped tabs keep
// Firefox's placement (where the tab is).

(function () {
  const MENU_ID = "tabContextMenu";
  const ITEM_ID = "context_moveTabToGroup";

  // The tab / group / split view right after `group` in the strip, or null.
  function elementAfter(group) {
    for (let n = group.nextElementSibling; n; n = n.nextElementSibling) {
      if (gBrowser.isTab?.(n) || gBrowser.isTabGroup?.(n) || gBrowser.isSplitViewWrapper?.(n)) {
        return n;
      }
    }
    return null;
  }

  // Run `fn` with gBrowser.addTabGroup creating the new group right after `group`.
  function withGroupAfter(group, fn) {
    const hadOwn = Object.hasOwn(gBrowser, "addTabGroup");
    const origAdd = gBrowser.addTabGroup;
    gBrowser.addTabGroup = function (tabs, opts = {}) {
      return origAdd.call(this, tabs, { ...opts, insertBefore: elementAfter(group) });
    };
    try {
      return fn();
    } finally {
      if (hadOwn) gBrowser.addTabGroup = origAdd;
      else delete gBrowser.addTabGroup;
    }
  }

  function wrapNewGroupCommand(name) {
    const orig = TabContextMenu[name];
    if (typeof orig !== "function") return false;
    TabContextMenu[name] = function (...args) {
      const group = this.contextTab?.group;
      if (!group) return orig.apply(this, args);
      return withGroupAfter(group, () => orig.apply(this, args));
    };
    return true;
  }

  function init() {
    const placed = wrapNewGroupCommand("moveTabsToNewGroup");
    wrapNewGroupCommand("moveSplitViewToNewGroup");

    const popup = document.getElementById(MENU_ID);
    if (!popup) {
      console.warn("[stack-move-to-group] #tabContextMenu not found");
      return;
    }

    let firefoxShowed = false;

    popup.addEventListener("popupshowing", (e) => {
      if (e.target !== popup) return; // ignore submenus bubbling up
      firefoxShowed = !document.getElementById(ITEM_ID)?.hidden;
    });

    window.addEventListener("popupshowing", (e) => {
      if (e.target !== popup || !firefoxShowed) return;
      if (!popup.triggerNode?.closest?.(".floorp-stack-tab")) return;
      const item = document.getElementById(ITEM_ID);
      if (item?.hidden) item.hidden = false;
    });

    console.log("[stack-move-to-group] loaded; new-group placement",
      placed ? "hooked" : "NOT hooked (TabContextMenu.moveTabsToNewGroup not found)");
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
