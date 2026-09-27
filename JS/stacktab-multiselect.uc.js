// ==UserScript==
// @name           stacktab-multiselect.uc.js
// @description    Stack tabs: Ctrl/Shift-click to multi-select
// @include        main
// ==/UserScript==

// Ctrl-click (Cmd on macOS) and Shift-click select multiple stack tabs, like
// global tabs. The selection is Firefox's real multiselection, so everything
// that acts on selected tabs — the tab context menu (close, move, add to
// group, unload…), dragging from the global strip, Ctrl+W — covers all of them.
//
// Floorp's stack strip tabs are proxies: its own click handler just selects
// the proxy's real tab, which wipes any multiselection. So on a modified
// left mousedown we run Firefox's own tab mousedown logic (tab.js
// on_mousedown) against the real tab, then swallow the click so Floorp
// doesn't select it:
//   • Shift         → range from the last multiselected tab to this one
//                     (Shift alone resets the selection first; Ctrl+Shift adds)
//   • Ctrl          → toggle this tab in/out of the selection
// A plain click clears the selection, like tab.js on_click.
//
// Floorp only styles the selected proxy, so we mirror each real tab's
// `multiselected` state onto its proxy as `uc-multiselected` and style it
// like a multiselected global tab (selected background + focus outline).
//
// Dragging a selected stack tab moves the whole selection. Floorp's proxy
// dragstart handler clears the multiselection, then calls
// tabDragAndDrop.startTabDrag(event, tab, { fromTabList: true }). The last
// selection is kept (updated on TabMultiSelect / TabSelect, which fire a
// microtask after a change, so it still holds the pre-clear selection there),
// and a startTabDrag wrapper re-selects it and records the drag, within the
// same handler, so nothing repaints in between and the highlight stays.
// This hooks the call rather than the dragstart event: a proxy can be
// re-rendered out of the document while the pointer rests on it, and a drag
// started from that stale node never reaches window listeners (and its event
// has no target).
// Re-selecting before startTabDrag also makes the drag carry every selected
// tab, so tearing off to a new window takes them all.
// Floorp's drops (into another stack, onto the global strip, reordering in the
// stack bar) place only the grabbed tab, so when the drag finishes the rest of
// the selection is gathered beside it in its original order. moveTabBefore/
// After insert next to it at the DOM level, so they join its stack or group
// (or leave theirs) along with it. Joining a stack drops a tab from the
// multiselection, so the selection is restored afterwards.

(function () {
  const PROXY_SEL = ".floorp-stack-tab";
  const BUTTON_SEL = ".floorp-stack-tab-close, .floorp-stack-tab-refresh";
  const MS_ATTR = "uc-multiselected";
  // Floorp fires this on window once a stack-bar drag is fully over, including
  // when the proxy that started it was re-rendered away and missed dragend.
  const PROXY_DRAG_END_EVENT = "floorp-stack-proxy-dragend";

  const CSS = `
    .floorp-stack-tab[${MS_ATTR}] {
      background: var(
        --tab-selected-bgcolor,
        var(--toolbarbutton-active-background, rgba(128, 128, 128, 0.3))
      );
      outline: 1px solid var(--focus-outline-color, AccentColor);
      outline-offset: -1px;
    }
  `;

  const isStack = (group) => group?.getAttribute?.("data-floorp-stack") === "true";

  const realTabOf = (proxy) => {
    const id = proxy?.getAttribute("data-floorp-drag-id");
    return id ? gBrowser.tabs.find(t => t.getAttribute("data-floorp-tab-id") === id) : null;
  };

  // Proxy under a left-button event, ignoring its close/reload buttons.
  const proxyFor = (e) =>
    e.button === 0 && !e.target.closest?.(BUTTON_SEL) ? e.target.closest?.(PROXY_SEL) : null;

  const isModified = (e) => e.shiftKey || e.getModifierState("Accel");

  // Mirrors tab.js on_mousedown's Shift / Accel branches.
  function multiSelect(tab, e) {
    if (e.shiftKey) {
      const last = gBrowser.lastMultiSelectedTab;
      if (!e.getModifierState("Accel")) {
        gBrowser.selectedTab = last;
        gBrowser.clearMultiSelectedTabs();
      }
      gBrowser.addRangeToMultiSelectedTabs(last, tab);
    } else if (tab.multiselected) {
      gBrowser.removeFromMultiSelectedTabs(tab);
    } else if (tab !== gBrowser.selectedTab) {
      gBrowser.addToMultiSelectedTabs(tab);
      gBrowser.lastMultiSelectedTab = tab;
    }
  }

  function syncProxies() {
    for (const proxy of document.querySelectorAll(PROXY_SEL)) {
      proxy.toggleAttribute(MS_ATTR, !!realTabOf(proxy)?.multiselected);
    }
  }

  // ---- dragging a multiselection ----
  let drag = null;        // { tab, tabs, group, prev, next } for the current drag
  let finishTimer = null;

  const liveHere = (el) => el.isConnected && !el.closing && el.ownerDocument === document;

  function restoreSelection(tabs) {
    const live = tabs.filter(liveHere);
    if (live.length < 2) return;
    for (const t of live) {
      if (!t.multiselected) gBrowser.addToMultiSelectedTabs(t);
    }
  }

  // Selected tabs (split views as a whole) line up beside the grabbed one:
  // those that came before it go before it, the rest after, in tab order.
  function gather(d, anchor) {
    const els = [...new Set(d.tabs.map(t => t.splitview ?? t))]
      .filter(el => liveHere(el) && !el.pinned);
    const i = els.indexOf(anchor);
    if (i < 0) return;
    for (const el of els.slice(0, i)) gBrowser.moveTabBefore(el, anchor);
    let prev = anchor;
    for (const el of els.slice(i + 1)) {
      gBrowser.moveTabAfter(el, prev);
      prev = el;
    }
  }

  function finishDrag() {
    const d = drag;
    drag = null;
    if (!d) return;
    const tab = d.tab;
    if (!liveHere(tab)) {        // torn off, or adopted by another window
      restoreSelection(d.tabs);
      return;
    }
    const anchor = tab.splitview ?? tab;
    const moved = tab.group !== d.group ||
      anchor.previousElementSibling !== d.prev ||
      anchor.nextElementSibling !== d.next;
    try {
      if (moved && !tab.pinned) gather(d, anchor);
    } catch (e) {
      console.error("[stack-multiselect] gather failed:", e);
    }
    restoreSelection(d.tabs);
    gBrowser.lastMultiSelectedTab = tab;
  }

  let lastSelection = [];  // gBrowser.selectedTabs as of the last change

  // A stack-bar drag of `tab` is starting and Floorp has just cleared the
  // selection: bring it back and record the drag.
  function beginDrag(tab) {
    drag = null;
    const tabs = lastSelection.filter(liveHere);
    if (tabs.length < 2 || !tabs.includes(tab)) return;
    for (const t of tabs) {
      if (!t.multiselected) gBrowser.addToMultiSelectedTabs(t);
    }
    gBrowser.lastMultiSelectedTab = tab;
    const anchor = tab.splitview ?? tab;
    drag = {
      tab,
      tabs,
      group: tab.group,
      prev: anchor.previousElementSibling,
      next: anchor.nextElementSibling,
    };
  }

  // Floorp's drop into another stack lands in a setTimeout(0) queued at drop,
  // which runs before this one.
  function scheduleFinish() {
    if (!drag || finishTimer) return;
    finishTimer = setTimeout(() => {
      finishTimer = null;
      finishDrag();
    }, 30);
  }

  let queued = false;
  function scheduleSync() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; syncProxies(); });
  }

  function init() {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    window.addEventListener("mousedown", (e) => {
      const proxy = proxyFor(e);
      if (!proxy || !isModified(e)) return;
      const tab = realTabOf(proxy);
      if (!tab) return;
      e.preventDefault(); // no focus/drag side effects from the modified press
      multiSelect(tab, e);
    }, true);

    window.addEventListener("click", (e) => {
      const proxy = proxyFor(e);
      if (!proxy) return;
      if (isModified(e)) {
        // Floorp's handler would select the tab and drop the selection.
        e.preventDefault();
        e.stopImmediatePropagation();
      } else if (gBrowser.multiSelectedTabsCount > 0) {
        gBrowser.clearMultiSelectedTabs();
      }
    }, true);

    const takeSelection = () => { lastSelection = gBrowser.selectedTabs; };
    window.addEventListener("TabMultiSelect", takeSelection);
    gBrowser.tabContainer.addEventListener("TabSelect", takeSelection);
    takeSelection();

    // Stack-bar drags: a stack member started with fromTabList. The event can't
    // be relied on to point at the proxy (a drag from a stale proxy has no
    // target at all), so the all-tabs menu, which also passes fromTabList, is
    // ruled out by its panel instead.
    const dnd = gBrowser.tabContainer.tabDragAndDrop;
    const origStartTabDrag = dnd.startTabDrag;
    dnd.startTabDrag = function (event, tab, options) {
      if (options?.fromTabList && isStack(tab?.group) &&
          !event?.target?.closest?.("panel")) {
        try {
          beginDrag(tab);
        } catch (e) {
          console.error("[stack-multiselect] drag start:", e);
        }
      }
      return origStartTabDrag.apply(this, arguments);
    };
    window.addEventListener("dragend", scheduleFinish, true);
    window.addEventListener(PROXY_DRAG_END_EVENT, scheduleFinish);

    window.addEventListener("TabMultiSelect", scheduleSync);
    gBrowser.tabContainer.addEventListener("TabSelect", scheduleSync);

    // The stack bar lives in the toolbox and re-renders its proxies when you
    // switch stacks or tabs join/leave one; new proxies need the attribute too.
    new MutationObserver(scheduleSync).observe(
      document.getElementById("navigator-toolbox"),
      { childList: true, subtree: true }
    );

    syncProxies();
    console.log("[stack-multiselect] loaded");
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
