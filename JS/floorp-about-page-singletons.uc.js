// ==UserScript==
// @name           floorp-about-page-singletons.uc.js
// @description    about: page singletons (about:hub, about:preferences open once, globally)
// @include        main
// ==/UserScript==

// Make designated about: pages behave as GLOBAL SINGLETONS — like Firefox's
// Settings does almost everywhere: opening one switches to the existing tab
// instead of duplicating, and it lives globally (never inside a stack), not
// wherever new tabs would land.
//
// Pages handled (SINGLETONS):
//   - about:hub          — Floorp Hub. Natively opens as an ordinary new tab
//                          (HubPanelMenu.tsx handleOpenHub → addTab), so it
//                          duplicated and followed new-tab placement (in-stack).
//   - about:preferences  — Firefox Settings. Already a singleton via the native
//                          openPreferences → switchToTabHavingURI path in most
//                          places, BUT the Floorp Hub's "Firefox Settings" button
//                          bypasses that and opens a duplicate. This catches it.
//
// HOW — one chokepoint. Every tab open funnels through gBrowser.addTab (the Hub
// buttons call it directly; native openPreferences reaches it via
// switchToTabHavingURI → openTrustedLinkIn → openLinkIn → addTab). So we wrap
// addTab and, for a singleton URL:
//   - a live tab for it already exists → select it and return it (no duplicate);
//   - none exists → open it once, forced GLOBAL: drop `relatedToCurrent`
//     (handleOpenHub passes it true, which inserts next to the current tab and
//     inherits its stack, overriding the index) and set index to the global end.
//
// FINDING THE EXISTING TAB — remember it, don't only scan by URL. about:hub does
// NOT keep `about:hub` as its committed URI once loaded (it resolves to an
// internal page), so a currentURI scan never matched it (every open logged
// "first"). We keep a direct tab REFERENCE per URL; a URL-prefix scan stays as a
// fallback to adopt a matching tab that was already open before this loaded
// (which works for about:preferences, whose URI stays about:preferences[#pane]).
//
// NOTE: stacktab-hotkey-opens-in-stack.uc.js ALSO wraps gBrowser.addTab; the two
// are disjoint (it handles blank gesture/keyboard opens, this handles these
// about: URLs), so they chain in either load order.

(function () {
  const LOG = "[about-singletons]";
  const SYS = () => Services.scriptSecurityManager.getSystemPrincipal();

  // Base URLs to treat as global singletons.
  const SINGLETONS = ["about:hub", "about:preferences"];

  // Which singleton base (if any) a requested URL belongs to. Matches the exact
  // page or any of its #panes (about:preferences#privacy), not lookalikes.
  const baseFor = (uri) => {
    if (typeof uri !== "string") return null;
    return SINGLETONS.find((b) => uri === b || uri.startsWith(b + "#")) || null;
  };

  const tracked = new Map(); // base URL -> the tab we opened/adopted for it

  function init() {
    const orig = gBrowser.addTab;
    if (typeof orig !== "function") {
      console.warn(LOG, "gBrowser.addTab not a function; singletons skipped");
      return;
    }

    // The live singleton tab for `base`, or null. Prefer our remembered
    // reference; if it's gone, fall back to a URL-prefix scan (adopts a tab open
    // before this script loaded — works where the committed URI keeps the base,
    // e.g. about:preferences).
    const living = (base) => {
      let t = tracked.get(base);
      if (t && !t.closing && gBrowser.tabs.includes(t)) return t;
      tracked.delete(base);
      for (const tab of gBrowser.tabs) {
        let spec = "";
        try { spec = tab.linkedBrowser?.currentURI?.spec || ""; } catch (e) {}
        if (!tab.closing && (spec === base || spec.startsWith(base + "#"))) {
          tracked.set(base, tab);
          return tab;
        }
      }
      return null;
    };

    gBrowser.addTab = function (uri, ...rest) {
      const base = baseFor(uri);
      if (base) {
        const existing = living(base);
        if (existing) {
          gBrowser.selectedTab = existing;
          console.log(LOG, "reused", base);
          return existing; // hand the caller the existing tab; create nothing
        }
        // First open → force GLOBAL. Preserve the caller's other params
        // (triggeringPrincipal, inBackground, …) so foregrounding etc. still
        // work; only strip the stack-inheriting bits and pin the index.
        const opts = { ...(rest[0] || {}) };
        delete opts.relatedToCurrent;
        delete opts.ownerTab;
        opts.index = gBrowser.tabs.length;
        if (!opts.triggeringPrincipal) opts.triggeringPrincipal = SYS();

        const tab = orig.call(this, uri, opts);
        tracked.set(base, tab);
        console.log(LOG, "opened", uri, "(global, first)");
        return tab;
      }
      return orig.call(this, uri, ...rest);
    };

    console.log(LOG, "loaded (" + SINGLETONS.join(", ") + ")");
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
