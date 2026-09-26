// ==UserScript==
// @name           Stack auto-title: unnamed stacks show their active tab's title and icon
// @include        main
// ==/UserScript==

// A stack that was never named ("New Stack", or a numbered "New Stack 2")
// displays the title and favicon of its active tab instead, like Vivaldi.
// Naming the stack (right-click → Manage Stack…) turns this off for that
// stack; clearing the name back to a default or empty turns it on again.
//
// Creating a stack also skips the name/color popup, since an unnamed stack
// now has a useful title on its own. Native Firefox groups still get the
// popup, and Manage Stack… still opens the editor normally.
//
// Display-only: we rewrite the header's visible text and icon, never the
// group's `label`. The real name stays "New Stack", so session restore, the
// rename panel and Floorp's own stack data are untouched, and the moment the
// stack is renamed Firefox writes the new label into the header itself.
//
// "Active tab" = the selected tab if it's in the stack, otherwise the stack's
// most recently used tab (lastAccessed) — i.e. the tab you'd land on.
//
// The header element is Firefox's `.tab-group-label`, but a stack renders it
// differently from a native group:
//   • group → the label's text content is the visible name.
//   • stack → the name is drawn by `::before` from the label's
//     `data-floorp-title` attribute, and the label's children are Floorp's
//     stack icon + close button. So for stacks we only rewrite that attribute
//     and never touch the children.
//
// Icon: Floorp's stack glyph is an <image class="floorp-stack-icon"> in the
// label. Floorp sets its `src` only when it creates it, so we point it at the
// active tab's favicon (the tab's `image` attribute, falling back to the same
// default favicon Floorp's row-2 tabs use) and put the saved glyph back when
// the stack is named. The `uc-auto-icon` attribute swaps the glyph styling
// (14px, tinted with the stack colour) for a plain 16px favicon box in the same
// spot, so it lines up with the favicons of global tabs. Floorp's hover swap to
// the close button keeps working since the element is unchanged.
//
// Loading: while the active tab is `busy`, a `.uc-stack-throbber` box in the
// same spot replaces the favicon and plays Firefox's tab throbber (the same
// sprite, timing, `progress` colour and reduced-motion fallback as tabs.css).
// It mirrors the tab's busy/progress/selected attributes, which Firefox
// announces through TabAttrModified. Like the icon, it gives way to the close
// button on hover.
//
// Popup: the editor panel (#tab-group-editor) has separate entry points for a
// new group (openCreateModal) and an existing one (openEditModal). We wrap
// only openCreateModal. The stack marker (data-floorp-stack) may be applied
// just after the group is created, so if the group isn't a stack yet when the
// popup is requested we re-check one tick later before deciding.

(function () {
  const DEFAULT_NAME = "New Stack";
  const OVERRIDE_ATTR = "uc-auto-title"; // marks a header we're overriding
  const FLOORP_TITLE_ATTR = "data-floorp-title"; // what a stack header renders
  const ICON_ATTR = "uc-auto-icon"; // marks a stack icon showing a favicon
  const ORIG_SRC_ATTR = "uc-stack-src"; // Floorp's glyph, saved while overridden
  const ICON_BUSY_ATTR = "uc-busy"; // hides the favicon while the throbber plays
  const THROBBER_CLASS = "uc-stack-throbber";
  const DEFAULT_FAVICON = "chrome://global/skin/icons/defaultFavicon.svg";

  const CSS = `
    tab-group[data-floorp-stack] .floorp-stack-icon[${ICON_ATTR}] {
      width: 16px;
      height: 16px;
      padding: 0;
      opacity: 1;
      -moz-context-properties: fill;
    }

    tab-group[data-floorp-stack] .${THROBBER_CLASS} {
      position: absolute;
      inset-inline-start: 6px;
      inset-block-start: 50%;
      transform: translateY(-50%);
      width: 16px;
      height: 16px;
      overflow: hidden;
      pointer-events: none;
    }

    tab-group[data-floorp-stack] .${THROBBER_CLASS}:not([busy]),
    tab-group[data-floorp-stack] .tab-group-label-container:hover .${THROBBER_CLASS},
    tab-group[data-floorp-stack] .floorp-stack-icon[${ICON_BUSY_ATTR}] {
      display: none;
    }

    @media (prefers-reduced-motion: reduce) {
      tab-group[data-floorp-stack] .${THROBBER_CLASS} {
        background-image: url("chrome://global/skin/icons/loading.svg");
        background-position: center;
        background-repeat: no-repeat;
        -moz-context-properties: fill;
        fill: currentColor;
        opacity: 0.4;
      }
      tab-group[data-floorp-stack] .${THROBBER_CLASS}[progress] {
        opacity: 0.8;
      }
    }

    @media (prefers-reduced-motion: no-preference) {
      :root[sessionrestored] tab-group[data-floorp-stack] .${THROBBER_CLASS}[busy]::before {
        content: "";
        position: absolute;
        background-image: url("chrome://browser/skin/tabbrowser/loading.svg");
        background-position: left center;
        background-repeat: no-repeat;
        width: 480px;
        height: 100%;
        animation: uc-stack-throbber 1.05s steps(30) infinite;
        -moz-context-properties: fill;
        fill: currentColor;
        opacity: 0.7;
      }
      :root[sessionrestored] tab-group[data-floorp-stack] .${THROBBER_CLASS}[busy]:-moz-locale-dir(rtl)::before {
        animation-name: uc-stack-throbber-rtl;
      }
      :root[sessionrestored] tab-group[data-floorp-stack] .${THROBBER_CLASS}[progress]::before {
        fill: var(--tab-loading-fill);
        opacity: 1;
      }
      :root[sessionrestored] #TabsToolbar[brighttext] tab-group[data-floorp-stack] .${THROBBER_CLASS}[progress]:not([selected])::before {
        fill: #84c1ff;
      }
    }

    @keyframes uc-stack-throbber {
      0% { transform: translateX(0); }
      100% { transform: translateX(-100%); }
    }
    @keyframes uc-stack-throbber-rtl {
      0% { transform: translateX(0); }
      100% { transform: translateX(100%); }
    }
  `;

  const logged = new WeakSet(); // stacks already described in the console

  const isStack = (group) => !!group?.hasAttribute?.("data-floorp-stack");
  const nameOf = (group) =>
    (group.label ?? group.getAttribute("label") ?? "").trim();
  // Floorp keeps stack names unique, so later default names get a number
  // appended ("New Stack 2", "New Stack (2)"); those count as unnamed too.
  const DEFAULT_NAME_RE = /^New Stack(?:[\s\-_#]*\(?\d+\)?)?$/;
  const isUnnamed = (group) => {
    const name = nameOf(group);
    return !name || DEFAULT_NAME_RE.test(name);
  };

  // ---------------------------------------------------------------- title --

  function activeTabOf(group) {
    const tabs = Array.from(group.tabs || []).filter(t => !t.closing);
    if (!tabs.length) return null;
    if (tabs.includes(gBrowser.selectedTab)) return gBrowser.selectedTab;
    return tabs.reduce((a, b) => ((b.lastAccessed || 0) > (a.lastAccessed || 0) ? b : a));
  }

  const labelElementOf = (group) =>
    group.labelElement || group.querySelector(".tab-group-label") || null;

  function describe(group, el) {
    if (logged.has(group)) return;
    logged.add(group);
    console.log("[stack-auto-title] stack",
      "label:", JSON.stringify(group.getAttribute("label")),
      "| header el:", el ? `<${el.localName} class="${el.className}">` : "NOT FOUND",
      "| data-floorp-title:", JSON.stringify(el?.getAttribute(FLOORP_TITLE_ATTR)),
      "| tabs:", group.tabs?.length);
  }

  // Stack → write `data-floorp-title` (children are icon/close, leave them).
  // Group → write the label's text content (it has no element children).
  function setText(el, text) {
    if (el.hasAttribute(FLOORP_TITLE_ATTR)) {
      if (el.getAttribute(FLOORP_TITLE_ATTR) !== text) el.setAttribute(FLOORP_TITLE_ATTR, text);
    } else if (el.childElementCount === 0 && el.textContent !== text) {
      el.textContent = text;
    }
  }

  function setIcon(icon, src) {
    if (!icon.hasAttribute(ICON_ATTR)) {
      icon.setAttribute(ORIG_SRC_ATTR, icon.getAttribute("src") || "");
      icon.setAttribute(ICON_ATTR, "true");
    }
    if (icon.getAttribute("src") !== src) icon.setAttribute("src", src);
  }

  function restoreIcon(icon) {
    if (!icon?.hasAttribute(ICON_ATTR)) return;
    icon.setAttribute("src", icon.getAttribute(ORIG_SRC_ATTR));
    icon.removeAttribute(ORIG_SRC_ATTR);
    icon.removeAttribute(ICON_ATTR);
    icon.removeAttribute(ICON_BUSY_ATTR);
  }

  // Created on first load and kept (hidden when idle) after that. `tab` null
  // → the stack isn't being overridden, so drop the throbber.
  function syncThrobber(el, icon, tab) {
    let throbber = el.querySelector(`:scope > .${THROBBER_CLASS}`);
    if (!tab) {
      throbber?.remove();
      return;
    }
    const busy = tab.hasAttribute("busy");
    if (!throbber) {
      if (!busy) return;
      throbber = document.createXULElement("hbox");
      throbber.classList.add(THROBBER_CLASS);
      el.appendChild(throbber);
    }
    throbber.toggleAttribute("busy", busy);
    throbber.toggleAttribute("progress", tab.hasAttribute("progress"));
    throbber.toggleAttribute("selected", tab.selected);
    icon?.toggleAttribute(ICON_BUSY_ATTR, busy);
  }

  function refreshGroup(group) {
    const el = labelElementOf(group);
    describe(group, el);
    if (!el) return;
    const icon = el.querySelector(":scope > .floorp-stack-icon");

    if (!isUnnamed(group)) {
      // Named (or just renamed) → hand the header back to the real name.
      if (el.hasAttribute(OVERRIDE_ATTR)) {
        el.removeAttribute(OVERRIDE_ATTR);
        setText(el, nameOf(group));
      }
      restoreIcon(icon);
      syncThrobber(el, icon, null);
      return;
    }

    const tab = activeTabOf(group);
    const title = tab?.label || DEFAULT_NAME;
    setText(el, title);
    if (icon) {
      if (tab) setIcon(icon, tab.getAttribute("image") || DEFAULT_FAVICON);
      else restoreIcon(icon);
    }
    syncThrobber(el, icon, icon && tab);
    if (el.getAttribute("tooltiptext") !== title) el.setAttribute("tooltiptext", title);
    el.setAttribute(OVERRIDE_ATTR, "true");
  }

  function refreshAll() {
    for (const group of document.querySelectorAll("tab-group[data-floorp-stack]")) {
      try { refreshGroup(group); }
      catch (e) { console.warn("[stack-auto-title] refresh failed", e); }
    }
  }

  // Coalesce bursts (tab switch fires select + attr-modified + mutations) into
  // one pass per frame. Our own writes re-trigger the observer, but the second
  // pass finds nothing to change, so it settles.
  let queued = false;
  function scheduleRefresh() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; refreshAll(); });
  }

  // ---------------------------------------------------------------- popup --

  function wrapCreateModal(target) {
    if (!target || typeof target.openCreateModal !== "function") return false;
    if (target.__ucNoCreatePopup) return true;
    const orig = target.openCreateModal;

    target.openCreateModal = function (group, ...rest) {
      if (isStack(group)) return undefined;
      setTimeout(() => {
        if (!isStack(group)) orig.call(this, group, ...rest);
      }, 0);
      return undefined;
    };

    target.__ucNoCreatePopup = true;
    return true;
  }

  // Prefer the class prototype (covers a panel that's created lazily); fall
  // back to the live panel instance's prototype.
  function hookCreatePopup() {
    if (wrapCreateModal(customElements.get("tabgroup-menu")?.prototype)) return true;
    const panel = gBrowser.tabGroupMenu || document.getElementById("tab-group-editor");
    return !!panel && wrapCreateModal(Object.getPrototypeOf(panel));
  }

  // ----------------------------------------------------------------- init --

  function init() {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const container = gBrowser.tabContainer;
    for (const type of [
      "TabSelect", "TabAttrModified", "TabOpen", "TabClose", "TabMove",
      "TabGrouped", "TabUngrouped", "TabGroupCreate", "TabGroupRemoved",
      "TabGroupExpand", "TabGroupCollapse",
    ]) {
      container.addEventListener(type, scheduleRefresh);
    }

    // Catches renames (tab-group `label` attr), stacks being built/restored,
    // and Floorp re-rendering the header title or icon behind our back.
    new MutationObserver(scheduleRefresh).observe(container, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ["label", FLOORP_TITLE_ATTR],
    });

    refreshAll();

    const hooked = hookCreatePopup();
    console.log("[stack-auto-title] loaded; create popup",
      hooked ? "suppressed for stacks" : "NOT hooked (openCreateModal not found)");
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
