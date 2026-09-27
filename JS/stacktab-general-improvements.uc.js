// ==UserScript==
// @name           Stack tabs: general improvements
// @include        main
// ==/UserScript==

// Makes stack tabs and stack chips look like global tabs: the indicators
// global tabs show, and the same button layout. Floorp's stack strip tabs
// are proxies that don't carry the real tab's state, so this mirrors it onto
// them, and onto the stack chip where it makes sense.
//
// Container line: container tabs in the global strip get a colored line
// along the bottom. Firefox colors it from `--identity-*` custom properties,
// set by the `identity-color-<name>` class a container tab carries
// (usercontext.css — those rules match any element). We copy that class plus
// `usercontextid` onto the proxy, so the color follows Firefox's own palette
// and theme. The line is the proxy's `::before`; Floorp uses `::after` for
// the separators between stack tabs.
//
// Audio button: a stack tab gets the speaker button a global tab shows next
// to its favicon — playing, muted, or autoplay-blocked. It is the same
// element a global tab uses (a `moz-button.tab-audio-button`) carrying the
// real tab's `soundplaying` / `muted` / `activemedia-blocked`, so whatever
// styles global tabs' audio buttons — Firefox's tabs.css, Floorp's Lepton
// theme and its options — styles it too. Two gaps are filled in:
//   • tabs.css only shows the button and draws its icon inside
//     #tabbrowser-tabs; the stack bar is outside it, so those rules are
//     repeated for the stack bar.
//   • the theme positions the button and title through custom properties
//     it sets on `.tabbrowser-tab` and `.tab-label-container`, which a proxy
//     isn't, so their computed values are copied from the real tab.
// Clicking it does what tab.js on_click does for `.tab-audio-button`: resume
// blocked media, otherwise toggle mute (on every selected tab when the tab is
// multiselected). Ctrl/Shift-clicks fall through, so they multiselect like on
// a global tab.
//
// The stack chip gets one too while any member is playing (or, failing that,
// muted): clicking it mutes every playing member, or unmutes every muted one.
// Autoplay-blocked media shows only on its own stack tab.
//
// Clicks on the buttons are caught on `windowRoot` in the capture phase —
// the first stop of every chrome event, ahead of Floorp's window-level
// capture listener that turns any chip click into "activate this stack" and
// the proxy's own click-to-select.
//
// Loading: Floorp's stack tabs only ever show the favicon. While the real
// tab is `busy`, a `.uc-stack-throbber` box beside the favicon in the
// iconbox takes its place and plays Firefox's tab throbber (the same sprite,
// timing, `progress` colour and reduced-motion fallback as tabs.css). The
// stack bar sits outside #TabsToolbar, so the bright-text colour keys off
// #TabsToolbar[brighttext] anywhere in the window.
//
// Close button: Floorp's stack tabs and chips swap their icon for a close
// button on hover. Here it sits at the right end instead and the icon stays,
// so it never collides with the audio button. On stack tabs, Floorp's
// hover-reload button moves in front of it, matching the global tab order:
// title, reload, close. The title (and the chip's tab count) gives up that
// space on hover so it never runs under the buttons. The chip also keeps the
// arrow cursor, like a global tab, instead of Floorp's pointer.
//
// Active tab: clicking a stack opens the tab last viewed in it, including
// after a restart (see onChipClick), and closing a tab that has to leave its
// stack or group for another one switches to that same last-viewed tab
// rather than the other stack's or group's nearest member.
//
// Closing a tab never leaves its stack, group or the global tabs unless it
// was the only tab there: it switches to the nearest loaded tab to the left,
// else the tab to the right, else the tab to the left. Unloading the
// selected tab follows the same rules among loaded tabs (see
// refreshSuccessor).

(function () {
  const PROXY_SEL = ".floorp-stack-tab";
  const STACK_ATTR = "data-floorp-stack";
  const COLOR_CLASS_RE = /^identity-color-/;
  const AUDIO_BTN = "uc-stack-audio-button";
  const AUDIO_ATTRS = ["soundplaying", "soundplaying-scheduledremoval", "muted", "activemedia-blocked"];
  const SYNC_ATTRS = [...AUDIO_ATTRS, "crashed", "busy", "progress"];
  const THROBBER_CLASS = "uc-stack-throbber";

  // Theme custom properties that position the button and title, and the
  // element of a real tab they're set on.
  const THEME_VARS = [
    [tab => tab, [
      "--tab-icon-end-margin",
      "--tab-min-width-extra-icons",
      "--uc-sound-tab-icon-position-x",
      "--uc-sound-tab-icon-position-y",
    ]],
    [tab => tab.querySelector(".tab-label-container"), [
      "--uc-sound-tab-label-position-x",
    ]],
  ];

  const PROXY_TOOLTIPS = { playing: "Mute tab", muted: "Unmute tab", blocked: "Play tab" };
  const CHIP_TOOLTIPS = { playing: "Mute stack", muted: "Unmute stack" };

  const ICON = "chrome://browser/skin/tabbrowser/";

  const CSS = `
    .floorp-stack-tab[usercontextid]::before {
      content: "";
      position: absolute;
      inset-inline: 6px;
      inset-block-end: 2px;
      height: 2px;
      border-radius: 1px;
      background: var(--identity-stroke-color, var(--identity-icon-color));
      pointer-events: none;
    }

    /* tabs.css's own rules, which only match inside #tabbrowser-tabs. */
    #floorp-stack-bar .tab-audio-button:not([crashed]) {
      &:is([soundplaying], [muted], [activemedia-blocked]) {
        display: flex;
      }
      &[soundplaying]::part(button) {
        background-image: url("${ICON}tab-audio-playing-small.svg");
      }
      &[muted]::part(button) {
        background-image: url("${ICON}tab-audio-muted-small.svg");
      }
      &[activemedia-blocked]::part(button) {
        background-image: url("${ICON}tab-audio-blocked-circle-12.svg");
      }
    }

    /* A global tab with the button grows its min-width and changes the
       favicon's end margin; the theme may also shift the title. */
    .floorp-stack-tab[uc-audio] {
      min-width: calc(var(--tab-min-width, 76px) + var(--tab-min-width-extra-icons, 0px)) !important;
    }
    .floorp-stack-tab[uc-audio] > .floorp-stack-tab-iconbox {
      margin-inline-end: var(--tab-icon-end-margin, 6px);
    }
    .floorp-stack-tab[uc-audio] > .floorp-stack-tab-label {
      transform: translateX(var(--uc-sound-tab-label-position-x, 0px));
    }

    /* Chip: the title is the label's ::before; sit in front of it, just
       past the (absolutely placed) stack icon. */
    tab-group[${STACK_ATTR}] .tab-group-label > .${AUDIO_BTN} {
      order: -1;
    }
    tab-group[${STACK_ATTR}] .tab-group-label[uc-audio]::before {
      transform: translateX(var(--uc-sound-tab-label-position-x, 0px));
    }

    /* ---- Close button on the right ---- */
    .floorp-stack-tab > .floorp-stack-tab-iconbox > .floorp-stack-tab-close {
      position: absolute !important;
      inset-inline-end: 6px !important;
      inset-block-start: 50% !important;
      transform: translateY(-50%) !important;
    }

    /* Floorp paints a solid backdrop so the X can cover the favicon; at the
       end of the tab it only needs the hover highlight. */
    .floorp-stack-tab > .floorp-stack-tab-iconbox > .floorp-stack-tab-close:not(:hover) {
      background-color: transparent !important;
    }

    .floorp-stack-tab:hover > .floorp-stack-tab-iconbox > .floorp-stack-tab-icon {
      display: revert-layer !important;
    }

    .floorp-stack-tab > .floorp-stack-tab-refresh {
      inset-inline-end: 24px !important;
    }

    .floorp-stack-tab:hover > .floorp-stack-tab-label {
      margin-inline-end: 14px !important;
    }

    :root[floorp-hover-reload] .floorp-stack-tab:hover > .floorp-stack-tab-label {
      margin-inline-end: 32px !important;
    }

    /* The stack bar sizes to its tabs' content widths (capped at their
       max-width), so the hover margin above would widen the bar whenever a
       short-titled tab is hovered, nudging every tab. A preferred width
       equal to Floorp's flex-basis makes each tab count the same whatever
       its content; flexing still shrinks them when space is short. */
    .floorp-stack-tab {
      width: 180px;
    }

    /* Chip: Floorp positions its close button absolutely inside the label,
       so only the side changes. */
    tab-group[${STACK_ATTR}] .tab-group-label > .floorp-stack-close {
      inset-inline-start: auto !important;
      inset-inline-end: 6px !important;
    }

    tab-group[${STACK_ATTR}] .tab-group-label > .floorp-stack-close:not(:hover) {
      background-color: transparent !important;
    }

    tab-group[${STACK_ATTR}] .tab-group-label-container:hover .floorp-stack-icon {
      display: revert-layer !important;
    }

    /* The tab count (the label's ::after, flush with its end padding) moves
       over to clear the close button, and the title's fade-out (the ::before
       mask) moves in with it, keeping the same gap. Both only change
       painting, not layout, so the chip keeps its width on hover even when
       something sizes it to fit its title. */
    tab-group[${STACK_ATTR}] .tab-group-label-container:hover .tab-group-label::after {
      position: relative;
      inset-inline-start: -15px;
    }
    tab-group[${STACK_ATTR}] .tab-group-label-container:hover .tab-group-label::before {
      mask-image: linear-gradient(to left, transparent 15px, black calc(15px + 1em));
    }

    /* ---- Loading throbber ---- */
    .floorp-stack-tab-iconbox > .${THROBBER_CLASS} {
      position: relative;
      width: 16px;
      height: 16px;
      overflow: hidden;
      pointer-events: none;
    }

    /* After the hover rule above, which it overrides while loading. */
    .floorp-stack-tab[uc-busy] > .floorp-stack-tab-iconbox > .floorp-stack-tab-icon,
    .floorp-stack-tab-iconbox > .${THROBBER_CLASS}:not([busy]) {
      display: none !important;
    }

    @media (prefers-reduced-motion: reduce) {
      .floorp-stack-tab-iconbox > .${THROBBER_CLASS} {
        background-image: url("chrome://global/skin/icons/loading.svg");
        background-position: center;
        background-repeat: no-repeat;
        -moz-context-properties: fill;
        fill: currentColor;
        opacity: 0.4;
      }
      .floorp-stack-tab-iconbox > .${THROBBER_CLASS}[progress] {
        opacity: 0.8;
      }
    }

    @media (prefers-reduced-motion: no-preference) {
      :root[sessionrestored] .floorp-stack-tab-iconbox > .${THROBBER_CLASS}[busy]::before {
        content: "";
        position: absolute;
        background-image: url("chrome://browser/skin/tabbrowser/loading.svg");
        background-position: left center;
        background-repeat: no-repeat;
        width: 480px;
        height: 100%;
        animation: uc-stack-tab-throbber 1.05s steps(30) infinite;
        -moz-context-properties: fill;
        fill: currentColor;
        opacity: 0.7;
      }
      :root[sessionrestored] .floorp-stack-tab-iconbox > .${THROBBER_CLASS}[busy]:-moz-locale-dir(rtl)::before {
        animation-name: uc-stack-tab-throbber-rtl;
      }
      :root[sessionrestored] .floorp-stack-tab-iconbox > .${THROBBER_CLASS}[progress]::before {
        fill: var(--tab-loading-fill);
        opacity: 1;
      }
      :root[sessionrestored]:has(#TabsToolbar[brighttext])
        .floorp-stack-tab:not([data-selected="true"]) > .floorp-stack-tab-iconbox > .${THROBBER_CLASS}[progress]::before {
        fill: #84c1ff;
      }
    }

    @keyframes uc-stack-tab-throbber {
      0% { transform: translateX(0); }
      100% { transform: translateX(-100%); }
    }
    @keyframes uc-stack-tab-throbber-rtl {
      0% { transform: translateX(0); }
      100% { transform: translateX(100%); }
    }

    /* Global tabs keep the arrow cursor; Floorp gives the chip a pointer. */
    tab-group[${STACK_ATTR}] .tab-group-label,
    tab-group[${STACK_ATTR}] .tab-group-label > .floorp-stack-close {
      cursor: default !important;
    }
  `;

  const tabIdOf = (proxy) => proxy.getAttribute("data-floorp-drag-id");
  const realTabOf = (proxy) => {
    const id = tabIdOf(proxy);
    return id ? gBrowser.tabs.find(t => t.getAttribute("data-floorp-tab-id") === id) : null;
  };

  // Precedence matches tabs.css, where the later rule wins:
  // activemedia-blocked > muted > soundplaying. Crashed tabs show no button.
  function tabAudioState(tab) {
    if (!tab || tab.hasAttribute("crashed")) return null;
    if (tab.hasAttribute("activemedia-blocked")) return "blocked";
    if (tab.hasAttribute("muted")) return "muted";
    if (tab.hasAttribute("soundplaying")) return "playing";
    return null;
  }

  function stackAudioState(group) {
    const states = group.tabs.map(tabAudioState);
    if (states.includes("playing")) return "playing";
    if (states.includes("muted")) return "muted";
    return null;
  }

  const setAttr = (el, name, value) => {
    if (value == null) {
      if (el.hasAttribute(name)) el.removeAttribute(name);
    } else if (el.getAttribute(name) !== value) {
      el.setAttribute(name, value);
    }
  };

  function copyThemeVars(tab, target) {
    for (const [elementOf, names] of THEME_VARS) {
      const el = tab && elementOf(tab);
      const style = el && getComputedStyle(el);
      for (const name of names) {
        const value = style?.getPropertyValue(name).trim();
        if (value) {
          if (target.style.getPropertyValue(name) !== value) target.style.setProperty(name, value);
        } else {
          target.style.removeProperty(name);
        }
      }
    }
  }

  // Keeps `parent`'s audio button showing `attrs` (audio attribute → value),
  // creating it with `place` or removing it when `attrs` is null.
  function syncAudioButton(parent, attrs, tooltip, place) {
    let btn = parent.querySelector(`:scope > .${AUDIO_BTN}`);
    if (!attrs) {
      btn?.remove();
      return;
    }
    if (!btn) {
      btn = document.createElementNS("http://www.w3.org/1999/xhtml", "moz-button");
      btn.className = `tab-audio-button ${AUDIO_BTN}`;
      btn.setAttribute("type", "icon ghost");
      btn.setAttribute("size", "small");
      btn.setAttribute("tabindex", "-1");
      place(btn);
    }
    for (const name of AUDIO_ATTRS) setAttr(btn, name, attrs[name] ?? null);
    setAttr(btn, "title", tooltip);
  }

  function syncContainer(proxy, tab) {
    const ctx = tab?.getAttribute("usercontextid");
    const color = ctx && Array.from(tab.classList).find(c => COLOR_CLASS_RE.test(c));

    for (const c of Array.from(proxy.classList)) {
      if (COLOR_CLASS_RE.test(c) && c !== color) proxy.classList.remove(c);
    }
    if (ctx && color) {
      setAttr(proxy, "usercontextid", ctx);
      proxy.classList.add(color);
    } else {
      setAttr(proxy, "usercontextid", null);
    }
  }

  function syncProxyAudio(proxy, tab) {
    const state = tabAudioState(tab);
    const attrs = state && Object.fromEntries(
      AUDIO_ATTRS.filter(a => tab.hasAttribute(a)).map(a => [a, tab.getAttribute(a)])
    );
    const iconbox = proxy.querySelector(":scope > .floorp-stack-tab-iconbox");
    setAttr(proxy, "uc-audio", state);
    copyThemeVars(state && tab, proxy);
    syncAudioButton(proxy, attrs, PROXY_TOOLTIPS[state],
      btn => iconbox ? iconbox.after(btn) : proxy.prepend(btn));
  }

  // Created the first time the tab loads and hidden when idle after that.
  function syncProxyThrobber(proxy, tab) {
    const iconbox = proxy.querySelector(":scope > .floorp-stack-tab-iconbox");
    if (!iconbox) return;
    const busy = !!tab?.hasAttribute("busy");
    let throbber = iconbox.querySelector(`:scope > .${THROBBER_CLASS}`);
    if (!throbber) {
      if (!busy) return;
      throbber = document.createXULElement("hbox");
      throbber.classList.add(THROBBER_CLASS);
      const icon = iconbox.querySelector(":scope > .floorp-stack-tab-icon");
      if (icon) icon.after(throbber);
      else iconbox.prepend(throbber);
    }
    setAttr(throbber, "busy", busy ? "true" : null);
    setAttr(throbber, "progress", tab?.hasAttribute("progress") ? "true" : null);
    setAttr(proxy, "uc-busy", busy ? "true" : null);
  }

  function syncChipAudio(group) {
    const label = group.querySelector(".tab-group-label");
    if (!label) return;
    // Groups Floorp doesn't present as stacks (plain groups, vertical mode)
    // keep their native look.
    const state = group.hasAttribute(STACK_ATTR) ? stackAudioState(group) : null;
    const attrs = state && { [state === "playing" ? "soundplaying" : "muted"]: "" };
    setAttr(label, "uc-audio", state);
    copyThemeVars(state && group.tabs.find(t => tabAudioState(t) === state), label);
    syncAudioButton(label, attrs, CHIP_TOOLTIPS[state], btn => label.append(btn));
  }

  function syncAll() {
    const tabsById = new Map(gBrowser.tabs.map(t => [t.getAttribute("data-floorp-tab-id"), t]));
    for (const proxy of document.querySelectorAll(PROXY_SEL)) {
      const tab = tabsById.get(tabIdOf(proxy)) ?? null;
      syncContainer(proxy, tab);
      syncProxyAudio(proxy, tab);
      syncProxyThrobber(proxy, tab);
    }
    for (const group of gBrowser.tabGroups) syncChipAudio(group);
  }

  let queued = false;
  function scheduleSync() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; syncAll(); });
  }

  function onAudioButtonClick(btn) {
    const proxy = btn.closest(PROXY_SEL);
    if (proxy) {
      const tab = realTabOf(proxy);
      if (!tab) return;
      if (tabAudioState(tab) === "blocked") {
        if (tab.multiselected) gBrowser.resumeDelayedMediaOnMultiSelectedTabs(tab);
        else tab.resumeDelayedMedia();
      } else if (tab.multiselected) {
        gBrowser.toggleMuteAudioOnMultiSelectedTabs(tab);
      } else {
        tab.toggleMuteAudio();
      }
      return;
    }
    const group = btn.closest(`tab-group[${STACK_ATTR}]`);
    if (!group) return;
    const state = stackAudioState(group);
    for (const tab of group.tabs) {
      if (tabAudioState(tab) === state) tab.toggleMuteAudio();
    }
  }

  // Plain left presses on a button stop here, before Floorp or the proxy see
  // them; mousedown's default is cancelled so it can't start a drag. The
  // moz-button's inner <button> is in its shadow tree, so events arrive
  // retargeted to the moz-button itself.
  function onPress(e) {
    if (e.button !== 0 || e.shiftKey || e.getModifierState("Accel")) return;
    const btn = e.target?.closest?.(`.${AUDIO_BTN}`);
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "click") onAudioButtonClick(btn);
  }

  // Clicking a stack that isn't active opens the tab you last viewed in it.
  // Floorp remembers that only in memory, so after a restart it opened the
  // first tab. Firefox's `lastAccessed` (what Ctrl+Tab orders by) survives
  // restarts via session restore, so the stack's most recently accessed
  // reachable tab is selected here and the click stops. Floorp's TabSelect
  // listener then records it and refreshes the chips as usual. A second
  // click of a double-click finds the stack active and passes through to
  // Floorp's rename dialog.
  function onChipClick(e) {
    if (e.button !== 0) return;
    const target = e.target;
    if (target?.closest?.(`.floorp-stack-close, .${AUDIO_BTN}`)) return;
    const group = target?.closest?.(".tab-group-label-container")
      ?.closest(`tab-group[${STACK_ATTR}]`);
    if (!group || gBrowser.selectedTab.group === group) return;
    const recent = activeTabOf(group);
    if (!recent) return;
    e.preventDefault();
    e.stopPropagation();
    gBrowser.selectedTab = recent;
  }

  // The stack's tab you last viewed: its most recently accessed reachable one.
  const activeTabOf = (group) => group.tabs
    .filter(t => !t.hidden && !t.closing)
    .reduce((a, t) => (!a || t.lastAccessed > a.lastAccessed ? t : a), null);

  // ---- Which tab closing the selected tab switches to ----
  // Closing the selected tab selects its successor if it has one, else
  // (tabbrowser _findTabToBlurTo) its opener, or the MRU tab when
  // browser.tabs.selectMRUOnClose is set, or the next visible tab in tab
  // order, else the previous. The successor is set so closing a tab never
  // leaves its container — its stack or group, the pinned tabs, or the other
  // global tabs — unless it's the only tab there:
  //   1. The nearest loaded tab to its left in the container.
  //   2. The tab to its right in the container: the one that takes its place.
  //   3. The tab to its left in the container.
  //   4. The nearest loaded tab outside the container in tab order (left
  //      wins a tie), where every other stack or group counts as one tab: its
  //      active tab, the one you last viewed there. Its members are
  //      consecutive in tab order, so without that you'd land on whichever
  //      member happens to sit at its edge.
  //   5. The nearest tab outside the container, loaded or not.
  // Tabs in collapsed groups aren't visible, so they're skipped. For tabs
  // outside stacks, the opener and MRU rules are left to Firefox.
  //
  // Firefox skips the successor when it's among the tabs it was told to
  // avoid: the other tabs being closed together, or, when unloading the
  // selected tab, every tab that isn't loaded. For those calls the same rules
  // are applied without the avoided tabs (see hookFindTabToBlurTo), so unloading
  // stays in the container when anything loaded is left there.
  //
  // Other successors are left alone — any set by someone else, apart from
  // Floorp's in-stack neighbour. Ours are tracked so they can be told apart
  // and cleared.
  const ourSuccessors = new WeakMap(); // tab → successor we set

  const isLoaded = (tab) =>
    !!tab.linkedPanel && !tab.hasAttribute("pending") && !tab.hasAttribute("discarded");

  const containerOf = (tab) => tab.group ?? (tab.pinned ? "pinned" : "global");

  const firefoxPicksOwnerOrMRU = (tab) =>
    (tab.owner?.visible && Services.prefs.getBoolPref("browser.tabs.selectOwnerOnClose", true))
    || Services.prefs.getBoolPref("browser.tabs.selectMRUOnClose", false);

  // The first tab in `units` passing `ok`, searching outward from `tab`,
  // left before right at each distance.
  function nearest(units, tab, ok) {
    const i = units.indexOf(tab);
    for (let d = 1; i >= 0 && d < units.length; d++) {
      for (const t of [units[i - d], units[i + d]]) {
        if (t && ok(t)) return t;
      }
    }
    return null;
  }

  function closeTarget(tab, avoid = new Set()) {
    const home = containerOf(tab);
    const remaining = gBrowser.visibleTabs
      .filter(t => t === tab || (!t.closing && !avoid.has(t)));

    // Its container, split at the tab: nearest first on each side.
    const members = remaining.filter(t => containerOf(t) === home);
    const i = members.indexOf(tab);
    const left = members.slice(0, i).reverse();
    const right = members.slice(i + 1);

    // Tab order, each other stack or group reduced to its active tab (among
    // its visible members: a collapsed group shows only its selected tab).
    const visible = new Set(remaining);
    const activeOf = (group) => group.tabs
      .filter(t => visible.has(t))
      .reduce((a, t) => (!a || t.lastAccessed > a.lastAccessed ? t : a), null);
    const units = [];
    let lastGroup = null;
    for (const t of remaining) {
      const group = t.group && t.group !== home ? t.group : null;
      if (group) {
        if (group !== lastGroup) units.push(activeOf(group) ?? t);
      } else {
        units.push(t);
      }
      lastGroup = group;
    }

    return left.find(isLoaded) ?? right[0] ?? left[0]
      ?? nearest(units, tab, isLoaded)
      ?? nearest(units, tab, () => true);
  }

  // Wraps tabbrowser _findTabToBlurTo for calls that pass tabs to avoid,
  // while the successor is ours.
  function hookFindTabToBlurTo() {
    const orig = gBrowser._findTabToBlurTo;
    if (typeof orig !== "function") return false;
    gBrowser._findTabToBlurTo = function (tab, excludeTabs = []) {
      if (tab?.selected && excludeTabs.length
          && tab.successor && tab.successor === ourSuccessors.get(tab)) {
        const avoid = new Set(excludeTabs);
        const fxView = window.FirefoxViewHandler?.tab; // Firefox avoids it too
        if (fxView) avoid.add(fxView);
        const pick = closeTarget(tab, avoid);
        if (pick) return pick;
      }
      return orig.call(this, tab, excludeTabs);
    };
    return true;
  }

  function refreshSuccessor() {
    const tab = gBrowser.selectedTab;
    if (!tab || tab.closing) return;
    const ours = ourSuccessors.get(tab);
    const inStack = !!tab.group?.hasAttribute(STACK_ATTR);
    const successor = tab.successor;
    if (successor && successor !== ours && !(inStack && successor.group === tab.group)) return;
    const pick = !inStack && firefoxPicksOwnerOrMRU(tab) ? null : closeTarget(tab);
    if (pick) {
      if (tab.successor !== pick) gBrowser.setSuccessor(tab, pick);
      ourSuccessors.set(tab, pick);
    } else if (ours) {
      gBrowser.setSuccessor(tab, null);
      ourSuccessors.delete(tab);
    }
  }

  // Runs after the event's other listeners (Floorp sets its successors
  // synchronously) and once per burst of events.
  let successorQueued = false;
  function scheduleSuccessor() {
    if (successorQueued) return;
    successorQueued = true;
    Promise.resolve().then(() => {
      successorQueued = false;
      try {
        refreshSuccessor();
      } catch (e) {
        console.error("[stack-general-improvements] close successor:", e);
      }
    });
  }

  function init() {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    // Proxies are (re)built when you switch stacks or tabs join/leave one,
    // and a chip's label children are replaced when the stack is renamed.
    gBrowser.tabContainer.addEventListener("TabSelect", scheduleSync);
    new MutationObserver(scheduleSync).observe(
      document.getElementById("navigator-toolbox"),
      { childList: true, subtree: true }
    );
    // Audio and loading state live in tab attributes.
    gBrowser.tabContainer.addEventListener("TabAttrModified", (e) => {
      if (e.detail?.changed?.some(a => SYNC_ATTRS.includes(a))) scheduleSync();
    });
    // A container's color can be edited in settings.
    Services.obs.addObserver(scheduleSync, "contextual-identity-updated");
    window.addEventListener("unload", () => {
      Services.obs.removeObserver(scheduleSync, "contextual-identity-updated");
    }, { once: true });

    for (const type of ["mousedown", "click", "dblclick"]) {
      window.windowRoot.addEventListener(type, onPress, true);
    }
    window.windowRoot.addEventListener("click", onChipClick, true);

    // Anything that changes the selected tab, its neighbours, or whether
    // they're loaded.
    for (const type of ["TabSelect", "TabOpen", "TabClose", "TabMove", "TabShow", "TabHide",
                        "TabPinned", "TabUnpinned", "TabGrouped", "TabUngrouped",
                        "TabGroupCollapse", "TabGroupExpand",
                        "TabBrowserInserted", "TabBrowserDiscarded"]) {
      gBrowser.tabContainer.addEventListener(type, scheduleSuccessor);
    }
    gBrowser.tabContainer.addEventListener("TabAttrModified", (e) => {
      if (e.detail?.changed?.some(a => a === "pending" || a === "discarded")) scheduleSuccessor();
    });
    if (!hookFindTabToBlurTo()) {
      console.warn("[stack-general-improvements] gBrowser._findTabToBlurTo not found; " +
        "closing several tabs or unloading may leave the stack/group");
    }
    scheduleSuccessor();

    syncAll();
    console.log("[stack-general-improvements] loaded");
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
