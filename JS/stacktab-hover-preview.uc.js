// ==UserScript==
// @name           stacktab-hover-preview.uc.js
// @description    Stack tabs: hover previews
// @include        main
// ==/UserScript==

// Hovering a stack tab shows Firefox's tab preview card (title, address,
// thumbnail if enabled) like a global tab, following Firefox's own setting
// (browser.tabs.hoverPreview.enabled) and delay. The stack tab's plain title
// tooltip is suppressed while previews are on, as Firefox does for tabs.
//
// Floorp's stack strip tabs are proxies; hovering one activates the real
// tab's preview (tab-hover-preview.mjs), the same call tabs.js makes on
// TabHoverStart. The card anchors to its tab, but a stack's real tabs are
// collapsed to nothing in the top row, so the panel's openPopup/moveToAnchor
// calls for that tab are pointed at its proxy instead. Pressing a stack tab
// closes its card, as clicking a tab does (and before a drag can start).
//
// Stacks keep a plain tooltip, but just the stack's name. Firefox's group
// tooltip reads "<name> — Expanded": tabgroup.js writes it to the group's
// `data-tooltip`, which the label inherits as `tooltiptext`, whenever the
// name or collapsed state changes. On stacks that attribute is rewritten to
// the name alone; a group that stops being a stack gets Firefox's text back.

(function () {
  const PROXY_SEL = ".floorp-stack-tab";
  const STACK_ATTR = "data-floorp-stack";
  // Stack tab buttons that keep their own tooltips.
  const PROXY_BUTTONS = ".floorp-stack-tab-close, .floorp-stack-tab-refresh";

  const tabs = () => gBrowser.tabContainer;
  const isStackGroup = (group) => !!group?.hasAttribute?.(STACK_ATTR);

  const realTabOf = (proxy) => {
    const id = proxy?.getAttribute("data-floorp-drag-id");
    return id ? gBrowser.tabs.find(t => t.getAttribute("data-floorp-tab-id") === id) : null;
  };
  // Looked up fresh each time: Floorp re-renders proxies.
  const proxyOf = (tab) => {
    const id = tab?.getAttribute("data-floorp-tab-id");
    return id ? document.querySelector(`${PROXY_SEL}[data-floorp-drag-id="${CSS.escape(id)}"]`) : null;
  };

  // ---- Stack tabs: the tab preview card ----
  let previewTab = null; // real tab whose card is anchored to its proxy

  function loadTabPanel() {
    tabs().ensureTabPreviewPanelLoaded();
    const panelSet = tabs().previewPanel;
    const panel = panelSet.tabPanel.panelElement;
    if (!panel.ucStackPreview) {
      panel.ucStackPreview = true;
      const anchorFor = (anchor) => (anchor && anchor === previewTab && proxyOf(anchor)) || anchor;
      const openPopup = panel.openPopup;
      panel.openPopup = function (anchor, ...rest) {
        return openPopup.call(this, anchorFor(anchor), ...rest);
      };
      const moveToAnchor = panel.moveToAnchor;
      panel.moveToAnchor = function (anchor, ...rest) {
        return moveToAnchor.call(this, anchorFor(anchor), ...rest);
      };
      panel.addEventListener("popuphidden", (e) => {
        if (e.target === panel) previewTab = null;
      });
    }
    return panelSet;
  }

  // Like tab.js's TabHoverStart/End: only on entering or leaving the proxy
  // itself, not when moving between its children.
  function onMouseOver(e) {
    const proxy = e.target.closest?.(PROXY_SEL);
    if (!proxy || proxy.contains(e.relatedTarget)) return;
    if (!tabs()._showTabHoverPreview) return;
    const tab = realTabOf(proxy);
    if (!tab || tab.closing) return;
    const panelSet = loadTabPanel();
    previewTab = tab;
    panelSet.activate(tab);
  }

  function onMouseOut(e) {
    const proxy = e.target.closest?.(PROXY_SEL);
    if (!proxy || proxy.contains(e.relatedTarget)) return;
    const tab = realTabOf(proxy);
    if (tab) tabs().previewPanel?.deactivate(tab);
  }

  function onMouseDown(e) {
    const target = e.target;
    if (target?.closest?.(".tab-audio-button")) return;
    const proxy = target?.closest?.(PROXY_SEL);
    if (proxy) tabs().previewPanel?.deactivate(realTabOf(proxy), { force: true });
  }

  // A `tooltiptext` tooltip is the document's default tooltip, which is
  // anonymous content of the root element: its popupshowing arrives
  // retargeted to the root, so the tooltip itself is `originalTarget`.
  function onTooltipShowing(e) {
    const tooltip = e.originalTarget;
    if (tooltip?.localName !== "tooltip") return;
    const node = tooltip.triggerNode ?? document.tooltipNode;
    if (!node?.closest?.(PROXY_SEL) || node.closest(PROXY_BUTTONS)) return;
    if (tabs()._showTabHoverPreview) e.preventDefault();
  }

  // ---- Stacks: tooltip without " — Expanded" ----
  const renamed = new WeakSet(); // groups whose tooltip we rewrote

  const groupName = (group) => group.label || group.defaultGroupName || "";

  function syncGroupTooltip(group) {
    if (isStackGroup(group)) {
      const name = groupName(group);
      if (group.dataset.tooltip !== name) group.dataset.tooltip = name;
      renamed.add(group);
    } else if (renamed.has(group)) {
      renamed.delete(group);
      // Firefox's own text, as tabgroup.js #updateTooltip builds it.
      gBrowser.tabLocalization
        .formatValue(
          group.collapsed ? "tab-group-label-tooltip-collapsed" : "tab-group-label-tooltip-expanded",
          { tabGroupName: groupName(group) }
        )
        .then(text => {
          if (!isStackGroup(group)) group.dataset.tooltip = text;
        });
    }
  }

  function init() {
    window.addEventListener("mouseover", onMouseOver);
    window.addEventListener("mouseout", onMouseOut);
    window.windowRoot.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("popupshowing", onTooltipShowing, true);

    // Firefox rewrites data-tooltip on rename/collapse; Floorp marks and
    // unmarks stacks with data-floorp-stack.
    new MutationObserver((records) => {
      const groups = new Set(records.map(r => r.target).filter(t => t.localName === "tab-group"));
      for (const group of groups) syncGroupTooltip(group);
    }).observe(tabs(), {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-tooltip", STACK_ATTR],
    });
    for (const group of gBrowser.tabGroups) syncGroupTooltip(group);

    console.log("[stack-hover-preview] loaded");
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
