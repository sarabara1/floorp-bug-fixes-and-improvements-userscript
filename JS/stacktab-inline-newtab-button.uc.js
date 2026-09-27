// ==UserScript==
// @name           stacktab-inline-newtab-button.uc.js
// @description    Stack new-tab button: position, click filtering, global-+ fix
// @include        main
// ==/UserScript==

// Two related behaviors for the stack's new-tab button (`#floorp-stack-newtab`),
// merged because the second only matters once the first moves the button.
//
// (1) POSITION — moves the button to sit right AFTER the tabs (inside
//     `#floorp-stack-items`) like the global tab bar's `+`. Natively it's a
//     child of `#floorp-stack-bar`, a sibling of the scroller, so it floats past
//     the scroll arrows instead of following the tabs.
//
//     DOM (from the inspector):
//       #floorp-stack-bar
//       ├─ #floorp-stack-scroll-up      (‹)
//       ├─ #floorp-stack-scroller       (the horizontal scroll box)
//       │   └─ #floorp-stack-items      (the tabs live here)
//       ├─ #floorp-stack-scroll-down    (›)
//       └─ #floorp-stack-newtab         (the + button — natively here)
//
//     - NOT overflowing → put the button inside #floorp-stack-items, after the
//       last tab, so it hugs the tabs.
//     - OVERFLOWING (arrows shown, tabs scroll) → move it back to the end of
//       #floorp-stack-bar (its native spot) so it stays visible instead of being
//       scrolled off inside the strip.
//
//     Overflow test: `scroller.scrollWidth > scroller.clientWidth`. Inlining the
//     button widens the scroller by ~its own width while adding ~its own width of
//     content, so this test yields the same result whichever parent holds the
//     button — no oscillation. A small dead-band guards the boundary anyway.
//
// (2) IGNORE NON-LEFT CLICKS — once inlined, the button sits inside
//     #floorp-stack-items, so a middle-click on it hit BOTH the button's own
//     new-tab action AND the stack-blank middle-click handler
//     (stacktab-mouse-improvements.uc.js) → two tabs. So on middle-click of the inlined
//     button we suppress the button's OWN action (which fires on `click`) with
//     stopPropagation — but NOT preventDefault, since that would also cancel the
//     follow-up `auxclick` the middle-click handler uses to open the ONE tab.
//     When the button is PARKED, that handler doesn't apply, so we leave it be
//     and the button opens the tab itself. Right-click is fully ignored.
//
// (3) GLOBAL + BUTTON — Floorp's default middle-clicks the main tab bar's `+`
//     (#tabs-newtab-button / #new-tab-button) into the ACTIVE STACK. With stacks
//     now carrying their own `+`, that's unwanted: middle-clicking the global +
//     should open a GLOBAL tab, like middle-clicking empty tab-bar space. So we
//     cancel the native open and open our own at the global end (foregrounded).

(function () {
  // `over` = scroller.scrollWidth - scroller.clientWidth (>0 means overflowing).
  // It's ~invariant to where the button sits (inlining frees its bar space to
  // the scroller), so a small hysteresis band [INLINE_AT, PARK_AT] suffices.
  // Note the scroller HUGS its content, so `over` is ~0 when tabs fit (not a big
  // negative slack) — INLINE_AT must be a small positive, not negative.
  const PARK_AT = 4;   // when inline: park once overflow exceeds this
  const INLINE_AT = 2; // when parked: inline once overflow drops below this

  function init() {
    let scheduled = false;
    let ro = null;
    let roTarget = null;

    function update() {
      const bar = document.getElementById("floorp-stack-bar");
      const items = document.getElementById("floorp-stack-items");
      const scroller = document.getElementById("floorp-stack-scroller");
      const btn = document.getElementById("floorp-stack-newtab");
      if (!bar || !items || !scroller || !btn) return;

      // Keep a ResizeObserver on the current scroller (it can be rebuilt).
      if (ro && roTarget !== scroller) { ro.disconnect(); roTarget = null; }
      if (ro && !roTarget) { ro.observe(scroller); roTarget = scroller; }

      const over = scroller.scrollWidth - scroller.clientWidth; // >0 = overflow
      const currentlyInline = btn.parentElement === items;

      // Dead-band: only flip when clearly over/under the threshold; otherwise
      // keep the current placement so a borderline width can't flicker.
      let inline;
      if (currentlyInline) inline = !(over > PARK_AT);
      else inline = over < INLINE_AT;

      if (inline) {
        if (btn.parentElement !== items || items.lastElementChild !== btn) {
          items.appendChild(btn);
          console.log("[stack-newtab] inline (over=" + Math.round(over) + ")");
        }
      } else {
        if (btn.parentElement !== bar || bar.lastElementChild !== btn) {
          bar.appendChild(btn);
          console.log("[stack-newtab] park (over=" + Math.round(over) + ")");
        }
      }
    }

    function schedule() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; update(); });
    }

    ro = new ResizeObserver(schedule);

    // Catch the strip being built/rebuilt (stack expand, stack switch) and tabs
    // being added/removed — all show up as childList changes under the toolbox.
    const toolbox = document.getElementById("navigator-toolbox") || document.documentElement;
    new MutationObserver(schedule).observe(toolbox, { childList: true, subtree: true });

    schedule();

    // ---- ignore non-left clicks on the button (see header note 2) ----
    const btnOf = (e) => e.target?.closest?.("#floorp-stack-newtab");
    const isInline = (btn) =>
      !!btn && !!document.getElementById("floorp-stack-items")?.contains(btn);

    // Focus the address bar after a new blank tab opens, like native new-tab —
    // Floorp's in-stack open (addTabToActiveGroup) doesn't. Deferred so it runs
    // after the tab switch settles.
    const focusUrlbar = () => {
      try { const u = window.gURLBar; if (u) { u.focus(); u.select?.(); } } catch (e) {}
    };

    // The button opens a tab in its `click` handler (addTabToActiveGroup) — and
    // this Floorp fires `click` for BOTH middle (button 1) and right (button 2),
    // not just left. So gate on the button number:
    //   - RIGHT (2) → always cut it: right-click should do nothing.
    //   - MIDDLE (1), button INLINED → cut the button's own action; the
    //     middle-click pass-through (stacktab-mouse-improvements.uc.js) opens the one
    //     tab on the follow-up `auxclick`. Parked → leave it, the button opens
    //     the tab itself. Either way, exactly one tab.
    // stopPropagation (NOT stopImmediatePropagation) so the sibling window
    // pass-through still runs; no preventDefault on middle so `auxclick` fires.
    window.addEventListener("click", function (e) {
      const btn = btnOf(e);
      if (!btn) return;
      if (e.button === 2) { e.preventDefault(); e.stopPropagation(); return; }
      if (e.button === 1 && isInline(btn)) { e.stopPropagation(); return; }
      // Left-click, or middle-click while parked: the button opens the in-stack
      // tab itself, but Floorp doesn't focus the address bar — do it.
      if (e.button === 0 || e.button === 1) setTimeout(focusUrlbar, 0);
    }, true);

    // Belt-and-suspenders for right-click: swallow the right-button auxclick and
    // any context menu (none observed, but cheap insurance).
    const swallowRight = (e) => {
      if ((e.type === "contextmenu" || e.button === 2) && btnOf(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("auxclick", swallowRight, true);
    window.addEventListener("contextmenu", swallowRight, true);

    // ---- GLOBAL tab bar's + button: middle-click opens a GLOBAL tab ----
    // Floorp's default middle-clicks the global `+` into the active stack (it
    // uses addTabToActiveGroup like the stack `+`) — likely an oversight now
    // that stacks have their own inline `+`. Make it match middle-clicking empty
    // tab-bar space instead: a new tab at the global end, focused. We cancel the
    // native open (on whichever of click/auxclick it fires) and open our own,
    // deduped so a single middle-click yields exactly one tab.
    const SYS = () => Services.scriptSecurityManager.getSystemPrincipal();
    const onGlobalPlus = (e) =>
      e.target?.closest?.("#tabs-newtab-button, #new-tab-button");
    let globalTick = false;
    function openGlobalTab() {
      if (globalTick) return;
      globalTick = true;
      setTimeout(() => { globalTick = false; }, 0);
      const t = gBrowser.addTab("about:newtab", {
        index: gBrowser.tabs.length, // global end, past all stacks
        triggeringPrincipal: SYS(),
      });
      gBrowser.selectedTab = t; // foreground, like the empty-space middle-click
      setTimeout(focusUrlbar, 0);
    }
    for (const type of ["click", "auxclick"]) {
      window.addEventListener(type, function (e) {
        if (e.button !== 1 || !onGlobalPlus(e)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        openGlobalTab();
      }, true);
    }

    console.log("[stack-newtab] loaded");
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
