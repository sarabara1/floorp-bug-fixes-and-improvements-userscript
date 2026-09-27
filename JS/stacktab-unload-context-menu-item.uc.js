// ==UserScript==
// @name           stacktab-unload-context-menu-item.uc.js
// @description    Group/stack context menu: Unload all tabs in group|stack
// @include        main
// ==/UserScript==

// Adds "Unload Stack|Group" to the GROUP/STACK context menu (the
// menu you get right-clicking a group or stack HEADER — not an individual tab;
// Floorp already ships a native per-tab "Unload Tab"). A Floorp stack IS a
// `tab-group` (with data-floorp-stack) and native groups are `tab-group` too,
// so one item covers both; the label swaps "group" ↔ "stack".
//
// Injection via a document-level popupshowing listener that handles two header
// menus and bails for individual tabs (so it never lands back on the per-tab
// menu):
//   • Floorp STACK header  → menupopup #floorp-stack-kind-menu (Reload Stack /
//     New Tab in Stack / Manage Stack…). Opened programmatically: NO triggerNode
//     and no stack id on the popup, so — like its own "New Tab in Stack" — it
//     targets the ACTIVE stack, resolved via the visible strip (see below).
//   • Native group header → whatever menupopup Firefox opens, target resolved
//     from the trigger's closest("tab-group").
// It logs the popup id each open so the actual menu stays visible for tuning.
//
// Unload primitive: gBrowser.discardBrowser(tab) — Firefox's tab-unload. It
// refuses the ACTIVE tab, so to unload the WHOLE stack we unload every other
// tab first, then switch to the nearest already-LOADED tab outside the stack
// (never waking a discarded tab), where another stack or group means its
// active tab (see loadedTabOutside), and unload the former-active one too. If no loaded tab exists outside the stack, a fresh global tab
// (about:newtab, at the end, outside all stacks) is opened to land on.

(function () {
  const isUnloadable = (tab) =>
    tab && !tab.closing && !tab.hasAttribute("pending"); // pending = already unloaded

  // discardBrowser took a <browser> on old builds, a <tab> on current ones.
  function discard(tab) {
    try { return gBrowser.discardBrowser(tab); }
    catch (e) {
      try { return gBrowser.discardBrowser(tab.linkedBrowser); }
      catch (e2) { console.warn("[tab-unload] discard failed", e2); return false; }
    }
  }

  const isLoaded = (tab) =>
    !!tab.linkedPanel && !tab.hasAttribute("pending") && !tab.hasAttribute("discarded");

  // Where to switch before unloading the group's active tab: the nearest
  // loaded tab outside `group` in tab order, left winning a tie, where every
  // other stack or group counts as one tab — its active tab, the one you last
  // viewed there (among its visible members: a collapsed group shows only its
  // selected tab). The same rule closing a tab uses when it has to leave its
  // stack (stacktab-general-improvements.uc.js). Null if nothing outside is
  // loaded.
  function loadedTabOutside(group) {
    const visible = gBrowser.visibleTabs.filter(t => !t.closing);
    const visibleSet = new Set(visible);
    const activeOf = (g) => g.tabs
      .filter(t => visibleSet.has(t))
      .reduce((a, t) => (!a || t.lastAccessed > a.lastAccessed ? t : a), null);

    // Tab order with `group` as one entry (null) and every other group as
    // its active tab.
    const units = [];
    let lastGroup;
    for (const t of visible) {
      const g = t.group ?? null;
      if (!g || g !== lastGroup) {
        if (g === group) units.push(null);
        else units.push(g ? activeOf(g) : t);
      }
      lastGroup = g;
    }

    const i = units.indexOf(null);
    for (let d = 1; i >= 0 && d < units.length; d++) {
      for (const t of [units[i - d], units[i + d]]) {
        if (t && isLoaded(t)) return t;
      }
    }
    return null;
  }

  function unloadGroup(group) {
    if (!group) return 0;
    const tabs = Array.from(group.tabs || []);
    const active = tabs.find(t => t.selected); // may be undefined (selection elsewhere)
    let n = 0;

    // Every non-active tab unloads directly.
    for (const t of tabs) {
      if (t.selected) continue;
      if (!isUnloadable(t)) continue;
      if (discard(t)) n++;
    }

    // The active tab (if it's in this group): switch to the nearest loaded tab
    // outside the group — or, if none is loaded, a fresh global tab — then it
    // can be discarded too.
    if (active && isUnloadable(active)) {
      let other = loadedTabOutside(group);
      if (!other) {
        other = gBrowser.addTab("about:newtab", {
          index: gBrowser.tabs.length, // global end, outside all stacks
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
      }
      gBrowser.selectedTab = other;
      if (discard(active)) n++;
    }
    return n;
  }

  // Floorp's stack header menu (id below) is opened programmatically (no
  // triggerNode) and carries no stack id — like its own "New Tab in Stack",
  // it acts on the ACTIVE stack (the one whose strip is shown). Resolve that
  // group via a visible strip tab's drag-id → real tab → group (same mapping
  // the middle-click script uses).
  // Both native GROUP headers and Floorp STACK headers open this same menu, so
  // the popup id alone can't tell them apart — we resolve the SPECIFIC group/
  // stack from the element that was right-clicked (below).
  const STACK_MENU_ID = "floorp-stack-kind-menu";

  function activeStackGroup() {
    const v = document.querySelector(".floorp-stack-tab[data-floorp-drag-id]");
    const id = v?.getAttribute("data-floorp-drag-id");
    const real = id && gBrowser.tabs.find(
      t => t.getAttribute("data-floorp-tab-id") === id
    );
    return real?.closest?.("tab-group[data-floorp-stack]") || real?.group || null;
  }

  // The group/stack a right-clicked element belongs to. Prefers the real DOM
  // (a native group label, or a stack backed by a tab-group), and only falls
  // back to the active stack when the click landed on a Floorp stack surface
  // that lives OUTSIDE the tab-group DOM (the strip).
  function groupFromNode(node) {
    const g = node?.closest?.("tab-group");
    if (g) return g;
    if (node?.closest?.("#floorp-stack-bar") || node?.closest?.(".floorp-stack-tab")) {
      return activeStackGroup();
    }
    return null;
  }

  function init() {
    let pendingGroup = null;  // group captured at popupshowing, acted on at command
    let lastCtxTarget = null; // last pressed element — floorp-stack-kind-menu has
                              // no triggerNode, so we resolve the group from here

    // Record what was pressed just before a menu opens (any button). Capture
    // phase so it runs before Floorp opens the popup.
    window.addEventListener("mousedown", (e) => { lastCtxTarget = e.target; }, true);

    // Lazily add our item to the top of a given popup, once.
    function ensureItem(popup) {
      const existing = popup.getElementsByClassName("uc-unload-group-item")[0];
      if (existing) return existing;
      const item = document.createXULElement("menuitem");
      item.className = "uc-unload-group-item";
      item.addEventListener("command", () => {
        if (!pendingGroup) return;
        console.log("[tab-unload] unloaded", unloadGroup(pendingGroup), "in group/stack");
      });
      popup.insertBefore(item, popup.firstChild);
      return item;
    }

    document.addEventListener("popupshowing", (e) => {
      const popup = e.target;
      if (!popup || popup.localName !== "menupopup") return;

      let group, isStack;
      if (popup.id === STACK_MENU_ID) {
        // Shared group/stack header menu → resolve the SPECIFIC one clicked
        // (triggerNode is null here, so use the last pressed element); fall back
        // to the active stack if that can't be resolved.
        group = groupFromNode(popup.triggerNode || lastCtxTarget) || activeStackGroup();
        if (!group) return;
        isStack = !!group.hasAttribute?.("data-floorp-stack");
      } else {
        // Native group (or any other) header menu, resolved from its trigger.
        const node = popup.triggerNode;
        if (!node) return;
        // Never the individual-tab targets — this belongs on the header only.
        if (node.closest?.(".tabbrowser-tab") || node.closest?.(".floorp-stack-tab")) return;
        group = node.closest?.("tab-group");
        if (!group) return; // not a group/stack header → leave this menu alone
        isStack = !!group.hasAttribute?.("data-floorp-stack");
      }
      if (!group) return;

      const item = ensureItem(popup);
      item.setAttribute("label", isStack ? "Unload Stack" : "Unload Group");
      // Enabled if anything in the group is unloadable — the active tab can
      // always be handled now (switch to a loaded tab, else open a global one).
      item.disabled =
        !Array.from(group.tabs || []).some(t => isUnloadable(t));
      item.hidden = false;
      pendingGroup = group;
      console.log("[tab-unload] menu:", popup.id || "(no id)",
        "stack:", isStack, "tabs:", group.tabs?.length);
    }, true);

    console.log("[tab-unload] loaded (group/stack menu injector)");
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
