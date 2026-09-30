// ==UserScript==
// @name           floorp-tab-overflow-fix.uc.js
// @description    Fixes the duplicate new tab button that breaks tab reordering
// @include        main
// ==/UserScript==

// The tab strip tracks "tabs don't fit" in two places:
//   • #tabbrowser-arrowscrollbox[overflowing] — set by the scrollbox itself
//     from a ResizeObserver, which then fires an overflow/underflow event.
//   • #tabbrowser-tabs[overflow] — set by tabs.js, only from those events.
// The two new tab buttons each follow a different one. The in-strip button
// (#tabs-newtab-button) hides on the scrollbox's `overflowing`; the toolbar
// button (#new-tab-button) shows on the tab strip's `overflow`. Tab dragging
// also reads `overflow`: at drag start, when the strip isn't overflowing,
// Firefox shifts the in-strip button (its container,
// #tabbrowser-arrowscrollbox-periphery) over by the dragged tab's width so it
// doesn't slide into the gap, and the drop range is clamped to that container.
//
// The scrollbox also marks whether it's scrolled to each end
// (`scrolledtostart` / `scrolledtoend`). The overflow indicators, 7px spacers
// with a shadow at each end of the strip, show whenever those are missing. The
// scrollbox sets both whenever it isn't overflowing.
//
// The scrollbox's connectedCallback clears `overflowing` without firing
// underflow or updating the scrolled-to marks, so if the scrollbox is
// re-attached (the tab bar moved in the DOM during startup) while the tabs
// overflowed, `overflow` stays set with nothing to clear it. Then:
//   • both new tab buttons show;
//   • an overflow indicator stays visible at the end of the strip;
//   • dragging a tab leaves the in-strip button unshifted, so it slides into
//     the dragged tab's spot and the drop range is clamped to it, which
//     breaks reordering until a restart.
//
// Fix: whenever any of these attributes changes, check them one frame later.
// If `overflow` disagrees with `overflowing`, fire the event the scrollbox
// skipped on the scrollbox. tabs.js then updates `overflow` through its own
// handlers, as does anything else listening (Floorp re-checks its tab scroll
// feature on these events). The scrollbox's attribute is the one backed by
// real measurements, so it wins. If the scrollbox isn't overflowing, both
// scrolled-to marks are set, as the scrollbox itself does. Each fix is logged
// to the Browser Console.

(function () {
  const LOG = "[tab-overflow-fix]";
  const SCROLLED_MARKS = ["scrolledtostart", "scrolledtoend"];

  function reconcile() {
    const tabs = gBrowser.tabContainer;
    const scrollbox = tabs?.arrowScrollbox;
    if (!scrollbox) return;
    const overflowing = scrollbox.hasAttribute("overflowing");

    if (tabs.hasAttribute("overflow") !== overflowing) {
      console.warn(LOG, "tab strip overflow state was stale; resyncing to",
        overflowing ? "overflowing" : "not overflowing");
      scrollbox.dispatchEvent(new CustomEvent(overflowing ? "overflow" : "underflow"));
    }

    if (!overflowing) {
      for (const mark of SCROLLED_MARKS) {
        if (scrollbox.hasAttribute(mark)) continue;
        console.warn(LOG, `tab strip fits but was missing ${mark}; setting it`);
        scrollbox.toggleAttribute(mark, true);
      }
    }
  }

  let queued = false;
  function scheduleReconcile() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; reconcile(); });
  }

  function init() {
    const tabs = gBrowser.tabContainer;
    const scrollbox = tabs?.arrowScrollbox;
    if (!scrollbox) {
      console.warn(LOG, "tab strip scrollbox not found; not running");
      return;
    }
    const observer = new MutationObserver(scheduleReconcile);
    observer.observe(tabs, { attributes: true, attributeFilter: ["overflow"] });
    observer.observe(scrollbox, { attributes: true, attributeFilter: ["overflowing", ...SCROLLED_MARKS] });
    scheduleReconcile();
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
