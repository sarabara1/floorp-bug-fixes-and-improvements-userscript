// ==UserScript==
// @name           floorp-tab-and-file-drag-fix.uc.js
// @description    Stack-aware drag and drop
// @include        main
// ==/UserScript==

// Drag and drop that understands stacks, in three parts:
//   • reordering in the global tab strip (row 1), below
//   • drags row 1 handles without animating: tabs from the stack bar or from
//     another window, and links, text and files
//   • links, text and files dropped on the stack bar (row 2)
//
// Makes reordering in the global tab strip treat each stack as one solid item:
//   • a tab slides past a stack in either direction instead of merging into it
//   • a dragged stack swaps with its neighbours at the same point both ways,
//     and can be dragged to the very end of the strip
//   • hovering a dragged tab on a stack for a moment highlights the stack and
//     dropping then adds the tab to it (Firefox's collapsed-group gesture)
// Everything else is Firefox's own drag and drop, untouched: the animation,
// pinning/unpinning, tear-off, creating groups, and dragging into ordinary
// tab groups.
//
// Why stacks confuse the drag engine: Floorp builds a stack as an EXPANDED
// tab-group whose member tabs are CSS-squashed to zero width behind the chip.
// Firefox's TabDragAndDrop (drag-and-drop.js) takes that literally:
//   - every member is a strip item — a run of zero-width items at the chip's
//     right edge. Overlap with a zero-width item always computes as 100%, so a
//     stack dragged left swaps the instant it touches the previous stack, while
//     dragging right can never overlap them, so it can't get past the last one.
//   - an expanded group's label marks "the start of the group": a tab moved
//     past it lands INSIDE the group, and a dragged group always lands before it.
//   - Floorp workspaces hide other workspaces' groups with display:none, but
//     their labels stay in the item list at screen x = 0, which scrambles the
//     engine's position search.
// A COLLAPSED group is exactly the atomic shape a stack has on screen, and the
// engine already handles those correctly. So for the length of a drag started
// in this strip, the engine is shown stacks as collapsed groups:
//   1. dragAndDropElements (the engine's list of strip items) drops stack
//      members and labels of display:none groups, and is re-indexed.
//   2. while _animateTabMove decides the drop spot, stacks report
//      collapsed = true and hasActiveTab = false — only for that synchronous
//      call, because Floorp keeps stacks expanded and re-expands any real
//      collapse through its TabGroupCollapse listener.
//   3. at drop, a position next to a stack's label is resolved to the stack
//      element itself; Tabbrowser reads "after an expanded group's label" as
//      "into the group".
// Dragging a stack also skips Firefox's collapse-the-group-while-dragging step
// (_dragData.expandGroupOnDrop): the stack already looks collapsed, and
// Floorp's re-expand would flip it back on every dragover.
//
// Floorp's own chip listeners treat any tab over a chip as "join this stack"
// and stop the dragover there, which keeps the engine from ever animating past
// a stack. Stack chips ignore the pointer while one of these drags runs, so
// those listeners stay idle and joining goes through the hover gesture above.
// Drags that start in the stack bar (row 2) or in another window never enable
// any of this.
//
// Stack-bar drags into this strip are Floorp's own: over a stack chip means
// "move the tab into that stack", anywhere else shows Floorp's insert caret.
// Stack chips sit edge to edge, so between two stacks the pointer is always on
// a chip and the caret never shows. While a stack-bar tab is dragged, only the
// middle half of each chip is a hit target (its ::before); near the edges the
// pointer reaches the strip, and Floorp places the tab on that side of the chip.
// Floorp also treats an expanded tab group as one block, so a stack-bar tab
// could only land before or after it. Over a group, the caret moves to the
// in-group spot a global tab would get, and after Floorp's drop the tab is
// moved there.
//
// The engine doesn't animate a tab dragged in from another window, or a link,
// text or file: it shows its caret at _getDropIndex and drops at that index
// (adopting the tab, or opening the links there). These threw that off, all
// fixed only while the engine handles one of those dragover or drop events:
//   - the item list: zero-width stack members made the right half of a stack
//     mean "into the stack", and hidden workspace groups at x = 0 put the
//     caret at the start when the pointer was past the last tab. The list is
//     filtered as in step 1.
//   - the target: in the tab bar but not on an item (around a group's label,
//     or on the top pixel row above a stack's chip), the engine read "the
//     end". The item nearest the pointer is used instead.
//   - Floorp's chip listeners turned any tab over a chip into "join this
//     stack". For a tab from another window, as for stack-bar drags, only
//     the middle half of each chip is a target (drop there to join); near the
//     edges the caret goes between. Links, text and files get the same: over
//     the middle half the stack is highlighted and the drop opens at its
//     end, which this script does itself as Floorp's listeners take tabs
//     only. A whole stack or group dragged in ignores chips entirely.
//
// Links, text and files dropped on the stack bar work as on the global strip:
// over the middle half of a stack tab the drop loads in that tab (text is
// searched), anywhere else it opens new tabs in the gap under the caret,
// inside that stack. Floorp doesn't accept these drops on the stack bar. A
// split view counts as one item, so nothing lands between its panes.

(function () {
  const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";
  const STACK_ATTR = "data-floorp-stack";
  const ACTIVE_ATTR = "stackdrag-active";
  const PROXY_ATTR = "stackproxy-drag";
  const EXTERNAL_ATTR = "stackexternal-drag"; // "join" or "group"
  const PROXY_DRAG_END_EVENT = "floorp-stack-proxy-dragend"; // Floorp's lost-dragend recovery
  const SETTLE_TIMEOUT_MS = 2000; // cap on waiting for the drop animation

  const CSS = `
    #tabbrowser-tabs:is([${ACTIVE_ATTR}], [${PROXY_ATTR}], [${EXTERNAL_ATTR}]) tab-group[${STACK_ATTR}] > .tab-group-label-container,
    #tabbrowser-tabs:is([${ACTIVE_ATTR}], [${PROXY_ATTR}], [${EXTERNAL_ATTR}]) tab-group[${STACK_ATTR}] > .tab-group-label-container * {
      pointer-events: none !important;
    }
    /* The container is position:relative (tabs.css). */
    #tabbrowser-tabs:is([${PROXY_ATTR}], [${EXTERNAL_ATTR}="join"]) tab-group[${STACK_ATTR}] > .tab-group-label-container::before {
      content: "";
      position: absolute;
      inset-block: 0;
      inset-inline: 25%;
      pointer-events: auto !important;
    }
    /* Hover-to-join cue: the same look as Floorp's drop-into-stack highlight. */
    #tabbrowser-tabs[movingtab-group] tab-group[${STACK_ATTR}] .tab-group-label[dragover-groupTarget] {
      background-color: color-mix(in srgb, var(--focus-outline-color, #0a84ff) 35%, transparent) !important;
      border-color: var(--focus-outline-color, #0a84ff) !important;
    }
  `;

  const isStack = (group) => group?.getAttribute?.(STACK_ATTR) === "true";

  function findDescriptor(obj, name) {
    for (let o = obj; o; o = Object.getPrototypeOf(o)) {
      const d = Object.getOwnPropertyDescriptor(o, name);
      if (d) return d;
    }
    return null;
  }

  // dataTransfer.types is a DOMStringList in some events and a frozen array in
  // others — probe both shapes.
  const dtHasType = (dt, t) => {
    const types = dt?.types;
    if (!types) return false;
    if (typeof types.includes === "function") return types.includes(t);
    if (typeof types.contains === "function") return types.contains(t);
    return Array.prototype.indexOf.call(types, t) >= 0;
  };

  // ---- links, text and files dropped on the stack bar ----------------------
  // The dropped-link service extracts URLs/text from a drop, resolves the
  // triggering principal and CSP, and rejects unsafe schemes.
  const dlh = () => Services.droppedLinkHandler;

  // A link, text or file — never a tab (Floorp's own stack-bar reorder and
  // tabs from other windows are Floorp's and Firefox's).
  function isExternalLinkDrop(e) {
    const dt = e.dataTransfer;
    if (!dt || dtHasType(dt, TAB_DROP_TYPE)) return false;
    try {
      if (dlh().canDropLink(e, true)) return true;
    } catch (err) {}
    // canDropLink can't read the data on dragover in some builds.
    return dtHasType(dt, "text/plain")
      || dtHasType(dt, "text/x-moz-url")
      || dtHasType(dt, "text/uri-list")
      || dtHasType(dt, "text/html");
  }

  // The real <tab> a stack-bar tab stands for (drag-id ↔ tab-id).
  function realTabForVisual(vTab) {
    const id = vTab?.getAttribute?.("data-floorp-drag-id");
    if (!id) return null;
    return gBrowser.tabs.find(t => t.getAttribute("data-floorp-tab-id") === id) || null;
  }

  // The stack a stack-bar strip shows, from any of its tabs.
  function stackGroupFromStrip(strip) {
    const real = realTabForVisual(strip.querySelector?.(".floorp-stack-tab[data-floorp-drag-id]"));
    return real?.closest?.(`tab-group[${STACK_ATTR}]`) || real?.group || null;
  }

  // A dropped token (a URL, or free text) as a loadable URL + optional
  // postData, resolved as the address bar and native tab-bar drops do: real
  // URLs pass through, keyword shortcuts expand, bare text becomes a
  // default-engine search. Falls back to URIFixup if the browser.js helper
  // isn't in scope.
  async function resolveDropText(text) {
    if (typeof getShortcutOrURIAndPostData === "function") {
      try {
        const d = await getShortcutOrURIAndPostData(text);
        if (d && d.url) return d;
      } catch (err) {
        console.warn("[tab-and-file-drag] getShortcutOrURIAndPostData failed", err);
      }
    }
    try {
      const flags =
        Ci.nsIURIFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP |
        Ci.nsIURIFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS;
      const info = Services.uriFixup.getFixupURIInfo(text, flags);
      const uri = info.preferredURI || info.fixedURI;
      if (uri) return { url: uri.spec, postData: null };
    } catch (err) {
      console.warn("[tab-and-file-drag] URIFixup fallback failed", err);
    }
    return null;
  }

  // Load a resolved URL into an existing tab (the "replace this tab" case).
  function loadInExistingTab(tab, data, triggeringPrincipal, csp) {
    const b = tab.linkedBrowser;
    const opts = { triggeringPrincipal, csp, postData: data.postData || null };
    try {
      if (typeof b.fixupAndLoadURIString === "function") {
        b.fixupAndLoadURIString(data.url, opts);
        return true;
      }
      if (typeof b.loadURI === "function") {
        b.loadURI(Services.io.newURI(data.url), opts);
        return true;
      }
    } catch (err) {
      console.warn("[tab-and-file-drag] load-in-tab failed", err);
    }
    return false;
  }

  // Where a drop lands on the stack bar — the global strip's rules
  // (drag-and-drop.js): over the middle half of a tab, replace that tab;
  // anywhere else, a new tab in the gap nearest the pointer.
  //   → { replace: tab } | { before: tab, x } | { after: tab, x } | { end: true }
  // `x` is the gap's client x, for the caret.

  // Stack-bar tabs grouped into drop items: a split's panes form one item.
  function dropItems(proxies) {
    const items = [];
    for (const p of proxies) {
      const pos = p.getAttribute("data-split-position");
      const prev = items.at(-1)?.at(-1);
      if ((pos === "middle" || pos === "last") && prev?.hasAttribute("data-split-position")) {
        items.at(-1).push(p);
      } else {
        items.push([p]);
      }
    }
    return items;
  }

  function itemRect(item) {
    const a = item[0].getBoundingClientRect();
    const b = item.at(-1).getBoundingClientRect();
    return { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right) };
  }

  function stackDropSpot(e, strip) {
    const items = dropItems(strip.querySelectorAll(".floorp-stack-tab"));
    if (!items.length) return { end: true };
    const rtl = window.RTL_UI;
    const x = e.clientX;

    const overProxy = e.target.closest?.(".floorp-stack-tab");
    if (overProxy) {
      const r = itemRect(items.find(item => item.includes(overProxy)));
      const w = r.right - r.left;
      if (x >= r.left + w * 0.25 && x <= r.left + w * 0.75) {
        const tab = realTabForVisual(overProxy);
        if (tab) return { replace: tab };
      }
    }

    for (const item of items) {
      const r = itemRect(item);
      if (rtl ? x > (r.left + r.right) / 2 : x < (r.left + r.right) / 2) {
        const tab = realTabForVisual(item[0]);
        if (tab) return { before: tab, x: rtl ? r.right : r.left };
      }
    }
    const last = items.at(-1);
    const r = itemRect(last);
    const tab = realTabForVisual(last.at(-1));
    return tab ? { after: tab, x: rtl ? r.left : r.right } : { end: true };
  }

  // The drop caret: Firefox's own tab-drag-indicator image, positioned over
  // the stack bar (Floorp gives #floorp-stack-bar position: relative) and
  // clamped to the visible strip. Dragover fires continuously while over a
  // target, so a short watchdog hides it once dragovers stop — including
  // when an OS file drag leaves the window, which fires no dragend here.
  const CARET_ID = "uc-stack-drop-caret";
  const CARET_CSS = `
    #${CARET_ID} {
      position: absolute;
      inset-block: 0;
      width: 12px;
      background: url(chrome://browser/skin/tabbrowser/tab-drag-indicator.svg) no-repeat center;
      pointer-events: none;
      z-index: 3;
    }
  `;
  let caretWatchdog = null;

  function hideCaret() {
    clearTimeout(caretWatchdog);
    const caret = document.getElementById(CARET_ID);
    if (caret) caret.hidden = true;
  }

  function showCaret(x) {
    const bar = document.getElementById("floorp-stack-bar");
    const scroller = document.getElementById("floorp-stack-scroller");
    if (!bar || x == null) return hideCaret();
    let caret = document.getElementById(CARET_ID);
    if (!caret || caret.parentNode !== bar) {
      caret?.remove();
      caret = document.createXULElement("hbox");
      caret.id = CARET_ID;
      bar.append(caret);
    }
    const view = (scroller ?? bar).getBoundingClientRect();
    const clamped = Math.min(Math.max(x, view.left), view.right);
    caret.style.left = `${Math.round(clamped - bar.getBoundingClientRect().left - 6)}px`;
    caret.hidden = false;
    clearTimeout(caretWatchdog);
    caretWatchdog = setTimeout(hideCaret, 250);
  }

  // Handle a drop at `spot` (from stackDropSpot): for a replace drop the first
  // item loads in the target tab and the rest open as new tabs after it;
  // otherwise every item opens as a new tab in the chosen gap, in order.
  // Switching tabs follows Firefox's drops on the tab strip (loadTabs): the
  // first new tab is selected unless the drop opens in the background, per
  // browser.tabs.loadInBackground with Shift reversing it; loading into the
  // target tab never selects it. The dataTransfer is only valid
  // synchronously, so everything is read off it before the first await.
  async function handleStackDrop(event, group, spot) {
    let inBackground = Services.prefs.getBoolPref("browser.tabs.loadInBackground", true);
    if (event.shiftKey) inBackground = !inBackground;

    const urls = [];
    try {
      const links = dlh().dropLinks(event, true); // true → reject javascript:/data:
      for (const l of links || []) if (l && l.url) urls.push(l.url);
    } catch (err) {
      console.warn("[tab-and-file-drag] dropLinks failed", err);
      return;
    }
    if (!urls.length) return;

    let triggeringPrincipal, csp;
    try {
      triggeringPrincipal = dlh().getTriggeringPrincipal(event);
      csp = dlh().getCsp(event);
    } catch (err) {
      triggeringPrincipal = Services.scriptSecurityManager.getSystemPrincipal();
      csp = null;
    }

    let firstAdded = null;
    let previous = null; // last tab placed, so later items follow it in order
    for (const url of urls) {
      const data = await resolveDropText(url);
      if (!data || !data.url) continue;

      if (!previous && spot.replace) {
        loadInExistingTab(spot.replace, data, triggeringPrincipal, csp);
        previous = spot.replace;
        continue;
      }
      const tab = gBrowser.addTab(data.url, {
        postData: data.postData,
        triggeringPrincipal,
        csp,
      });
      placeInStack(tab, group, previous ? { after: previous } : spot);
      firstAdded ??= tab;
      previous = tab;
    }
    if (firstAdded && !inBackground) gBrowser.selectedTab = firstAdded;
  }

  // Move a new tab into `group` at `spot`. moveTabBefore/After insert next to
  // the target at the DOM level, so the tab joins the target's stack (a split
  // target resolves to its whole split view). Otherwise it goes at the
  // stack's end.
  function placeInStack(tab, group, spot) {
    try {
      if (spot.before?.group === group) gBrowser.moveTabBefore(tab, spot.before);
      else if (spot.after?.group === group) gBrowser.moveTabAfter(tab, spot.after);
      else group.addTabs([tab]);
    } catch (err) {
      console.warn("[tab-and-file-drag] placing a dropped tab failed", err);
    }
  }

  function initStackBarDrops() {
    const caretStyle = document.createElement("style");
    caretStyle.textContent = CARET_CSS;
    document.head.appendChild(caretStyle);

    window.addEventListener("dragend", hideCaret, true);

    // dragover must be cancelled for the stack bar to accept the drop. The
    // drop effect is left alone, as on the tab strip, so the cursor shows the
    // same operation.
    window.addEventListener("dragover", (e) => {
      const strip = e.target.closest?.("#floorp-stack-items");
      if (!strip || !isExternalLinkDrop(e)) {
        hideCaret();
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      const spot = stackDropSpot(e, strip);
      if (spot.replace) hideCaret();
      else showCaret(spot.x);
    }, true);

    window.addEventListener("drop", (e) => {
      const strip = e.target.closest?.("#floorp-stack-items");
      if (!strip || !isExternalLinkDrop(e)) {
        hideCaret();
        return;
      }
      const group = stackGroupFromStrip(strip);
      if (!group) {
        // Couldn't resolve the stack: leave the drop to Floorp/Firefox.
        console.warn("[tab-and-file-drag] drop: couldn't resolve the stack; ignoring");
        hideCaret();
        return;
      }
      const spot = stackDropSpot(e, strip);
      e.preventDefault();
      e.stopImmediatePropagation();
      hideCaret();
      handleStackDrop(e, group, spot);
    }, true);
  }

  function init() {
    // Independent of the engine patches below.
    initStackBarDrops();

    const tabs = gBrowser.tabContainer;
    const dnd = tabs?.tabDragAndDrop;
    const groupProto = customElements.get("tab-group")?.prototype;
    const itemsDesc = findDescriptor(tabs, "dragAndDropElements");
    const collapsedDesc = groupProto && findDescriptor(groupProto, "collapsed");
    const activeTabDesc = groupProto && findDescriptor(groupProto, "hasActiveTab");
    if (!dnd?._animateTabMove || !dnd.handle_drop || !dnd.handle_dragover || !dnd.startTabDrag ||
        !itemsDesc?.get || !collapsedDesc?.set || !activeTabDesc?.set) {
      console.error("[tab-and-file-drag] drag engine not as expected; not patching");
      return;
    }

    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const dragService = Cc["@mozilla.org/widget/dragservice;1"]
      .getService(Ci.nsIDragService);

    // ---- drag lifecycle ----------------------------------------------------
    let active = false;     // engine sees stacks as collapsed
    let dragged = null;     // the tab / split view / group label being dragged
    let keep = new Set();   // moving items, never filtered out
    let activatedAt = 0;
    let settleGen = 0;
    let settling = false;
    let lastBase = null;    // engine's own item list the filtered one came from
    let lastItems = null;
    let unanimated = false; // inside the engine's handling of an unanimated drag

    const isStackMember = (el) =>
      (gBrowser.isTab(el) || gBrowser.isSplitViewWrapper(el)) && isStack(el.group);

    function activate(item) {
      settleGen++;
      settling = false;
      activatedAt = performance.now();
      active = true;
      dragged = item;
      keep = new Set(item.multiselected ? gBrowser.selectedElements : [item]);
      lastBase = lastItems = null;
      tabs.setAttribute(ACTIVE_ATTR, "");
    }

    // Chips take the pointer back right away. The filtered item list stays
    // until the drop animation has finished: the engine's deferred move still
    // reads it.
    function endDrag() {
      tabs.removeAttribute(ACTIVE_ATTR);
      if (!active || settling) return;
      settling = true;
      const gen = settleGen;
      const deadline = performance.now() + SETTLE_TIMEOUT_MS;
      const settle = () => {
        if (gen !== settleGen) return;
        if (tabs.querySelector("[tabdrop-samewindow]") && performance.now() < deadline) {
          requestAnimationFrame(settle);
          return;
        }
        active = false;
        settling = false;
        dragged = null;
        keep = new Set();
        lastBase = lastItems = null;
        // Rebuild the engine's list so every item gets its real elementIndex back.
        tabs._invalidateCachedVisibleTabs();
      };
      requestAnimationFrame(settle);
    }

    // ---- 1. item list: one item per stack ----------------------------------
    Object.defineProperty(tabs, "dragAndDropElements", {
      configurable: true,
      get() {
        const base = itemsDesc.get.call(this);
        if (!active && !unanimated) return base;
        if (base === lastBase) return lastItems;
        const items = [];
        for (const el of base) {
          if (!keep.has(el)) {
            if (gBrowser.isTabGroupLabel(el)) {
              if (el.group?.style.display === "none") continue; // other workspace
            } else if (isStack(el.group)) {
              continue;
            }
          }
          el.elementIndex = items.length;
          items.push(el);
        }
        lastBase = base;
        lastItems = items;
        return items;
      },
    });

    // ---- 2. drop-spot decision: stacks read as collapsed -------------------
    const origAnimate = dnd._animateTabMove;
    dnd._animateTabMove = function (event) {
      if (!active) return origAnimate.call(this, event);
      const stacks = gBrowser.tabGroups.filter(isStack);
      for (const g of stacks) {
        Object.defineProperty(g, "collapsed", {
          configurable: true,
          get: () => true,
          set(v) { collapsedDesc.set.call(this, v); },
        });
        Object.defineProperty(g, "hasActiveTab", {
          configurable: true,
          get: () => false,
          set(v) { activeTabDesc.set.call(this, v); },
        });
      }
      try {
        return origAnimate.call(this, event);
      } finally {
        for (const g of stacks) {
          delete g.collapsed;
          delete g.hasActiveTab;
        }
      }
    };

    // ---- drags the engine doesn't animate: one item per stack -------------
    // A tab (or group label) dragged in from another window, or null.
    function foreignSource(event) {
      const dt = event.dataTransfer;
      if (!dtHasType(dt, TAB_DROP_TYPE) || tabs.verticalMode) return null;
      const src = dt.mozGetDataAt(TAB_DROP_TYPE, 0);
      return src && src.ownerDocument !== document ? src : null;
    }

    // A tab from another window, or a link, text or file. Tabs dragged within
    // this window are animated, or are Floorp's own stack-bar drags.
    const isUnanimatedDrag = (event) =>
      !tabs.verticalMode && !!event.dataTransfer &&
      (!dtHasType(event.dataTransfer, TAB_DROP_TYPE) || !!foreignSource(event));

    // The item list is filtered only while the engine handles one event, then
    // rebuilt so every item gets its real elementIndex back.
    function withStackItems(fn) {
      unanimated = true;
      lastBase = lastItems = null;
      try {
        return fn();
      } finally {
        unanimated = false;
        lastBase = lastItems = null;
        tabs._invalidateCachedVisibleTabs();
      }
    }

    // In the tab bar but not on a tab, label or the scroll box itself (the
    // space around a group's label, or the top pixel row above a stack's
    // chip), the engine finds no target and reads it as "the end". The item
    // at the pointer's x, or the nearest one, is used instead; past the last
    // item that is still the end.
    const origTarget = dnd._getDragTarget;
    dnd._getDragTarget = function (event, options = {}) {
      const found = origTarget.call(this, event, options);
      if (found || !unanimated || options.ignoreSides || options.findClosestTarget === false ||
          !event.target?.closest?.("#tabbrowser-tabs")) {
        return found;
      }
      let nearest = null;
      let best = Infinity;
      for (const el of tabs.dragAndDropElements) {
        const box = gBrowser.isTabGroupLabel(el)
          ? el.closest(".tab-group-label-container") : el;
        const r = box?.getBoundingClientRect();
        if (!r?.width) continue;
        const d = event.clientX < r.left ? r.left - event.clientX
          : event.clientX > r.right ? event.clientX - r.right : 0;
        if (d < best) {
          best = d;
          nearest = el;
        }
      }
      return nearest;
    };

    const origDragover = dnd.handle_dragover;
    dnd.handle_dragover = function (event) {
      if (!isUnanimatedDrag(event)) return origDragover.call(this, event);
      return withStackItems(() => origDragover.call(this, event));
    };

    // Chips give up the pointer (see the CSS) from the first dragover until
    // the drop, or until the pointer is next used after the drag ended
    // elsewhere (endIfNoSession). A tab from another window, or a link, text
    // or file, can still join a stack over the middle half of its chip
    // ("join"); a whole stack or group can't ("group").
    let externalAt = 0;
    function trackExternal(event) {
      const src = foreignSource(event);
      const kind = src ? (gBrowser.isTabGroupLabel(src) ? "group" : "join")
        : !tabs.verticalMode && isExternalLinkDrop(event) ? "join" : null;
      if (!kind) {
        if (tabs.hasAttribute(EXTERNAL_ATTR)) tabs.removeAttribute(EXTERNAL_ATTR);
        return;
      }
      if (tabs.getAttribute(EXTERNAL_ATTR) !== kind) tabs.setAttribute(EXTERNAL_ATTR, kind);
      externalAt = performance.now();
    }
    const endExternal = () => tabs.removeAttribute(EXTERNAL_ATTR);
    window.addEventListener("dragenter", trackExternal, true);
    window.addEventListener("dragover", trackExternal, true);
    window.addEventListener("drop", () => setTimeout(endExternal), true);

    // Floorp's chip listeners take tabs only, so a link, text or file over the
    // middle half of a chip is handled here the same way: the stack shows
    // Floorp's drop-into highlight (the attribute its tab drops use), and the
    // drop opens at the end of the stack. Floorp's dragover listener clears
    // that highlight on every dragover, so it's set in a frame callback,
    // which lands after every listener whatever order they were registered
    // in, and before the repaint. The watchdog clears it when dragovers stop.
    const DROP_INTO_ATTR = "data-floorp-drop-into";
    let chipTarget = null;
    let chipWatchdog = null;
    const clearChipTarget = () => {
      clearTimeout(chipWatchdog);
      chipTarget = null;
      for (const g of tabs.querySelectorAll(`tab-group[${STACK_ATTR}][${DROP_INTO_ATTR}]`)) {
        g.removeAttribute(DROP_INTO_ATTR);
      }
    };
    const drawChipTarget = () => {
      if (chipTarget?.isConnected) chipTarget.setAttribute(DROP_INTO_ATTR, "true");
    };
    const linkChipTarget = (event) => {
      if (tabs.verticalMode || !isExternalLinkDrop(event)) return null;
      return event.target?.closest?.(".tab-group-label-container")
        ?.closest(`#tabbrowser-tabs tab-group[${STACK_ATTR}]`) ?? null;
    };
    window.addEventListener("dragover", (event) => {
      const group = linkChipTarget(event);
      if (!group) {
        if (chipTarget) clearChipTarget();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const ind = tabs.querySelector(".tab-drop-indicator");
      if (ind) ind.hidden = true;
      if (chipTarget && chipTarget !== group) chipTarget.removeAttribute(DROP_INTO_ATTR);
      chipTarget = group;
      requestAnimationFrame(drawChipTarget);
      clearTimeout(chipWatchdog);
      chipWatchdog = setTimeout(clearChipTarget, 250);
    }, true);
    window.addEventListener("drop", (event) => {
      const group = linkChipTarget(event);
      if (!group) return;
      event.preventDefault();
      event.stopPropagation();
      clearChipTarget();
      handleStackDrop(event, group, { end: true });
    }, true);

    // ---- 3. drop: "next to the label" means next to the stack --------------
    const origDrop = dnd.handle_drop;
    dnd.handle_drop = function (event) {
      if (isUnanimatedDrag(event)) {
        return withStackItems(() => origDrop.call(this, event));
      }
      if (active) {
        try {
          const src = event.dataTransfer?.mozGetDataAt(TAB_DROP_TYPE, 0);
          const data = src && src === dragged ? src._dragData : null;
          const target = data?.dropElement;
          // A hover-join keeps the label: the engine adds the tabs to its group.
          if (target && !data.shouldDropIntoCollapsedTabGroup &&
              !keep.has(target) && isStack(target.group)) {
            data.dropElement = target.group;
          }
        } catch (e) {
          console.error("[tab-and-file-drag] drop:", e);
        }
      }
      return origDrop.call(this, event);
    };

    // ---- drag start --------------------------------------------------------
    const origStart = dnd.startTabDrag;
    dnd.startTabDrag = function (event, tab, options) {
      // Floorp starts stack-bar drags here with fromTabList (so does the
      // all-tabs menu, from inside its panel).
      if (options?.fromTabList && isStackMember(tab) &&
          tab.ownerDocument === document && !event?.target?.closest?.("panel")) {
        beginProxyDrag(tab);
      }
      const eligible = !options?.fromTabList && !tabs.verticalMode &&
        tab?.ownerDocument === document && !isStackMember(tab);
      if (!eligible) return origStart.apply(this, arguments);

      // Before the original: multi-select drags index the item list at start.
      activate(tab);
      let result;
      try {
        result = origStart.apply(this, arguments);
      } catch (e) {
        endDrag();
        throw e;
      }
      if (!tab._dragData) {
        endDrag();
      } else if (gBrowser.isTabGroupLabel(tab) && isStack(tab.group)) {
        tab._dragData.expandGroupOnDrop = false;
      }
      return result;
    };

    window.addEventListener("dragend", () => {
      if (active || tabs.hasAttribute(ACTIVE_ATTR)) endDrag();
    }, true);

    // ---- stack-bar drags ----------------------------------------------------
    // Started from the startTabDrag hook: a drag from a proxy the stack bar has
    // just re-rendered away never reaches window dragstart listeners.
    let proxyDrag = null;   // { tab, into, fixQueued }
    let proxyDragAt = 0;

    function beginProxyDrag(tab) {
      proxyDrag = { tab, into: null, fixQueued: false };
      proxyDragAt = performance.now();
      tabs.setAttribute(PROXY_ATTR, ""); // chip edges belong to the strip
    }
    const endProxyDrag = () => {
      tabs.removeAttribute(PROXY_ATTR);
      proxyDrag = null;
    };
    window.addEventListener("dragend", endProxyDrag, true);
    window.addEventListener(PROXY_DRAG_END_EVENT, endProxyDrag);

    // Into an expanded group: the spot Firefox would use for a tab under the
    // pointer. Over a member, its near side; over the label's trailing half,
    // the group's start. The label's leading half is "before the group", which
    // Floorp already handles. Returns { ref, before, x } or null.
    function spotInGroup(x) {
      for (const g of gBrowser.tabGroups) {
        if (isStack(g) || g.collapsed || g.style.display === "none") continue;
        const members = g.tabsAndSplitViews.filter(el => el.visible);
        const labelBox = g.labelElement?.closest(".tab-group-label-container");
        if (!members.length || !labelBox) continue;
        const lr = labelBox.getBoundingClientRect();
        const lastRect = members.at(-1).getBoundingClientRect();
        if (x < lr.left || x > lastRect.right) continue;
        if (x < lr.left + lr.width / 2) return null;
        for (const el of members) {
          const r = el.getBoundingClientRect();
          if (x < r.left + r.width / 2) return { ref: el, before: true, x: r.left };
        }
        return { ref: members.at(-1), before: false, x: lastRect.right };
      }
      return null;
    }

    // Floorp's strip caret (showStripDropLine), moved to the in-group spot.
    // Drawn in a frame callback so it lands after Floorp's own dragover
    // listener, whichever order the two were registered in.
    function drawGroupCaret() {
      const into = proxyDrag?.into;
      const ind = tabs.querySelector(".tab-drop-indicator");
      if (!into || !ind) return;
      const rect = tabs.arrowScrollbox.getBoundingClientRect();
      ind.hidden = false;
      ind.style.transform = `translateX(${Math.round(into.x - rect.left + ind.clientWidth / 2)}px)`;
    }

    window.addEventListener("dragover", (event) => {
      if (!proxyDrag) return;
      const inStrip = !!event.target?.closest?.("#TabsToolbar");
      proxyDrag.into = inStrip ? spotInGroup(event.clientX) : null;
      if (proxyDrag.into) requestAnimationFrame(drawGroupCaret);
    }, true);

    // Floorp's strip drop ungroups the tab and places it before/after the whole
    // group, inside its drop listener. The first move it makes queues the
    // correction, which runs once that listener returns — before repaint,
    // dragend, or anything timer-based (e.g. the multiselect gather).
    function onProxyTabMoved(tab) {
      const d = proxyDrag;
      if (!d || tab !== d.tab || !d.into || d.fixQueued) return;
      d.fixQueued = true;
      const { ref, before } = d.into;
      queueMicrotask(() => {
        try {
          if (!ref.isConnected || !tab.isConnected || ref === tab) return;
          if (before) gBrowser.moveTabBefore(tab, ref);
          else gBrowser.moveTabAfter(tab, ref);
        } catch (e) {
          console.error("[tab-and-file-drag] drop into group:", e);
        }
      });
    }
    tabs.addEventListener("TabMove", (e) => onProxyTabMoved(e.target));
    // Dispatched on the group it left, with the tab as detail.
    window.addEventListener("TabUngrouped", (e) => onProxyTabMoved(e.detail));

    // A drag that ends without a dragend (a stack-bar drag's source node can be
    // re-rendered away mid-drag) must not leave chips unclickable. The platform
    // session starts just after dragstart, hence the grace period.
    const endIfNoSession = () => {
      if (!active && !tabs.hasAttribute(ACTIVE_ATTR) && !tabs.hasAttribute(PROXY_ATTR) &&
          !tabs.hasAttribute(EXTERNAL_ATTR)) return;
      if (performance.now() - Math.max(activatedAt, proxyDragAt, externalAt) < 500) return;
      let session = null;
      try {
        session = dragService.getCurrentSession(window);
      } catch {
        return;
      }
      if (!session) {
        endDrag();
        endProxyDrag();
        endExternal();
      }
    };
    window.addEventListener("mousemove", endIfNoSession, true);
    window.addEventListener("mousedown", endIfNoSession, true);

    console.log("[tab-and-file-drag] loaded");
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
