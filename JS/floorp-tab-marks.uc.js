// ==UserScript==
// @name           Tab marks: colored border on chosen tabs
// @include        main
// ==/UserScript==

// Right-click a tab, global or in a stack, and pick a color under "Mark Tab"
// to give it a thin border in that color, so it's easy to keep track of.
// "Remove Mark" takes it off. With several tabs selected, the menu marks them
// all, like any other tab context menu action.
//
// Colors are Firefox's tab group palette (`--tab-group-<color>` from
// tabs.css), so they follow the theme and light/dark mode the way group
// colors do. The menu shows each with the group chicklet icon, the same as
// the "Add Tab to Group" submenu.
//
// Persistence: the mark is saved with SessionStore.setCustomTabValue, which
// session restore stores with the tab. It comes back after a restart, with
// Reopen Closed Tab and on duplicates, and moves with a tab dragged to
// another window. The tab carries it as a `uc-mark` attribute, read back from
// SessionStore whenever a tab may have gained one:
//   • TabOpen, a microtask later: SessionStore creates restored tabs (startup,
//     Reopen Closed Tab/Window/Group) and fills in their values in one go, and
//     moves an adopted tab's values during its TabOpen.
//   • SSWindowRestored: the startup window's restore, which can reuse tabs
//     that already existed.
//   • SSTabRestoring: a tab whose history was just restored, e.g. a
//     duplicate. For a tab that hasn't loaded yet this only comes when it's
//     first selected, which is why the events above are needed.
//
// Border: an inset box-shadow. It follows the tab's shape and leaves alone
// the outline (focus, multiselection), the border (Floorp's split view tabs)
// and the pseudo-elements the theme and Floorp already use. On a global tab
// it sits on `.tab-background`. Stack tabs are Floorp's proxies, so the
// attribute is copied onto them, and Floorp's drop-position indicator (also
// an inset shadow) is kept alongside it while dragging. Floorp's separator
// lines are hidden on either side of a marked stack tab, as they are around
// the selected one. The border is the color at --uc-tab-mark-opacity; change
// that or --uc-tab-mark-width below to taste.
//
// Menu: Firefox lays out the tab context menu with MenuSectionLayout, which
// won't arrange a menu holding items it doesn't know. So the submenu is added
// after Firefox has set the menu up for this opening, and removed when it
// closes. Floorp points the menu at the real tab behind a stack tab, so
// TabContextMenu.contextTabs is right for both kinds of tab.

(function () {
  const KEY = "uc-tab-mark"; // SessionStore custom tab value
  const ATTR = "uc-mark";
  const PROXY_SEL = ".floorp-stack-tab";
  const MENU_ID = "tabContextMenu";
  const ANCHOR_ID = "context_openAndOrganizeSeparator";

  // Firefox's tab group colors, in its color picker's order.
  const COLORS = [
    ["blue", "Blue"],
    ["purple", "Purple"],
    ["cyan", "Cyan"],
    ["orange", "Orange"],
    ["yellow", "Yellow"],
    ["pink", "Pink"],
    ["green", "Green"],
    ["gray", "Gray"],
    ["red", "Red"],
  ];

  const CSS = `
    :root {
      --uc-tab-mark-width: 1px;
      --uc-tab-mark-opacity: 50%;
    }

    ${COLORS.map(([c]) =>
      `:is(.tabbrowser-tab, ${PROXY_SEL})[${ATTR}="${c}"] { --uc-mark-color: color-mix(in srgb, var(--tab-group-${c}) var(--uc-tab-mark-opacity), transparent); }`
    ).join("\n    ")}

    #tabbrowser-tabs .tabbrowser-tab[${ATTR}] > .tab-stack > .tab-background {
      box-shadow: inset 0 0 0 var(--uc-tab-mark-width) var(--uc-mark-color) !important;
    }

    ${PROXY_SEL}[${ATTR}] {
      box-shadow: inset 0 0 0 var(--uc-tab-mark-width) var(--uc-mark-color);
    }
    ${PROXY_SEL}[${ATTR}][data-drop-side="before"] {
      box-shadow: inset 2px 0 0 var(--focus-outline-color, #0a84ff),
                  inset 0 0 0 var(--uc-tab-mark-width) var(--uc-mark-color);
    }
    ${PROXY_SEL}[${ATTR}][data-drop-side="after"] {
      box-shadow: inset -2px 0 0 var(--focus-outline-color, #0a84ff),
                  inset 0 0 0 var(--uc-tab-mark-width) var(--uc-mark-color);
    }

    /* Floorp's separators sit on each stack tab's end edge, on top of or
       right beside a mark's border; hide them there, as Floorp does around
       the selected tab. */
    ${PROXY_SEL}[${ATTR}]::after,
    ${PROXY_SEL}:has(+ ${PROXY_SEL}[${ATTR}])::after {
      background: transparent !important;
    }
  `;

  const isColor = (c) => COLORS.some(([name]) => name === c);

  const setAttr = (el, name, value) => {
    if (value == null) {
      if (el.hasAttribute(name)) el.removeAttribute(name);
    } else if (el.getAttribute(name) !== value) {
      el.setAttribute(name, value);
    }
  };

  function applyMark(tab) {
    if (!tab || tab.closing) return;
    const color = SessionStore.getCustomTabValue(tab, KEY);
    setAttr(tab, ATTR, isColor(color) ? color : null);
  }

  function syncProxies() {
    const proxies = document.querySelectorAll(PROXY_SEL);
    if (!proxies.length) return;
    const tabsById = new Map(gBrowser.tabs.map(t => [t.getAttribute("data-floorp-tab-id"), t]));
    for (const proxy of proxies) {
      const tab = tabsById.get(proxy.getAttribute("data-floorp-drag-id"));
      setAttr(proxy, ATTR, tab?.getAttribute(ATTR) ?? null);
    }
  }

  let queued = false;
  function scheduleSync() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; syncProxies(); });
  }

  function setMark(tabs, color) {
    for (const tab of tabs) {
      if (color) SessionStore.setCustomTabValue(tab, KEY, color);
      else SessionStore.deleteCustomTabValue(tab, KEY);
      applyMark(tab);
    }
    syncProxies();
  }

  function buildMenu() {
    const menu = document.createXULElement("menu");
    menu.id = "uc-context_markTab";
    const popup = document.createXULElement("menupopup");
    menu.append(popup);

    for (const [color, label] of COLORS) {
      const item = document.createXULElement("menuitem");
      item.classList.add("menuitem-iconic", "tab-group-icon");
      item.setAttribute("label", label);
      item.style.setProperty("--tab-group-color", `var(--tab-group-${color})`);
      item.style.setProperty("--tab-group-color-invert", `var(--tab-group-${color}-invert)`);
      item.style.setProperty("--tab-group-color-pale", `var(--tab-group-${color}-pale)`);
      item.style.setProperty("--tab-group-background-color", `var(--tab-group-${color})`);
      item.addEventListener("command", () => setMark(TabContextMenu.contextTabs, color));
      popup.append(item);
    }

    popup.append(document.createXULElement("menuseparator"));
    const remove = document.createXULElement("menuitem");
    remove.addEventListener("command", () => setMark(TabContextMenu.contextTabs, null));
    popup.append(remove);

    return { menu, remove };
  }

  function init() {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const applyAll = () => {
      for (const tab of gBrowser.tabs) applyMark(tab);
      scheduleSync();
    };
    applyAll();

    const tabs = gBrowser.tabContainer;
    tabs.addEventListener("TabOpen", (e) => {
      queueMicrotask(() => { applyMark(e.target); scheduleSync(); });
    });
    tabs.addEventListener("SSTabRestoring", (e) => { applyMark(e.target); scheduleSync(); });
    window.addEventListener("SSWindowRestored", applyAll);

    // Proxies are (re)built when you switch stacks or tabs join/leave one.
    new MutationObserver(scheduleSync).observe(
      document.getElementById("navigator-toolbox"),
      { childList: true, subtree: true }
    );

    const popup = document.getElementById(MENU_ID);
    if (!popup) {
      console.warn("[tab-marks] #tabContextMenu not found");
      return;
    }
    const { menu, remove } = buildMenu();

    // Registered after Firefox's own listener on the popup, so the menu is
    // arranged and TabContextMenu.contextTabs is set by the time this runs.
    popup.addEventListener("popupshowing", (e) => {
      if (e.target !== popup) return;
      const contextTabs = TabContextMenu.contextTabs ?? [];
      const many = contextTabs.length > 1;
      menu.setAttribute("label", many ? "Mark Tabs" : "Mark Tab");
      remove.setAttribute("label", many ? "Remove Marks" : "Remove Mark");
      remove.disabled = !contextTabs.some(t => t.hasAttribute(ATTR));
      const anchor = document.getElementById(ANCHOR_ID);
      if (anchor?.parentNode === popup) anchor.before(menu);
      else popup.append(menu);
    });
    popup.addEventListener("popuphidden", (e) => {
      if (e.target === popup) menu.remove();
    });

    console.log("[tab-marks] loaded");
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
