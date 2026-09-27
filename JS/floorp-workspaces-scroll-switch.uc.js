// ==UserScript==
// @name           floorp-workspaces-scroll-switch.uc.js
// @description    Workspaces: scroll the toolbar button to switch (no wrap)
// @include        main
// ==/UserScript==

// Mouse-wheel over the Workspaces toolbar button (#workspaces-toolbar-button)
// switches workspaces: down/right = next, up/left = previous. NO WRAP — scrolling
// past the first or last workspace does nothing.
//
// API (found via Browser Toolbox, §6-style probing):
//   • window.workspacesFuncs.getSelectedWorkspaceID()  → current workspace id.
//   • window.workspacesFuncs.changeWorkspace(id)        → switch to that workspace.
//   • pref "floorp.workspaces.v4.store" is JSON holding `order` — the ORDERED
//     array of workspace ids (also `data` [id,{name,…}] and `defaultID`).
// The workspacesFuncs methods are opaque native bindings (toString = [native
// code]), and there's no list-getter among them, so the ORDER comes from the
// pref. It's re-read on every scroll, so adding/removing/reordering workspaces is
// picked up with no reload. `changeWorkspaceToNext/Previous` exist too but their
// wrap behavior isn't introspectable — so we index `order` and clamp ourselves to
// guarantee no wrap. (NB: the global getWorkspaceID() is a DIFFERENT id space —
// not in the store — so we use getSelectedWorkspaceID().)
//
// Self-contained: no dependency on the other scripts. Robust to the button being
// rebuilt by CustomizableUI — the wheel listener is delegated on the window and
// gated by closest("#workspaces-toolbar-button"), rather than bound to the node.

(function () {
  const BUTTON_ID = "workspaces-toolbar-button";
  const STORE_PREF = "floorp.workspaces.v4.store";
  // Wheel distance (normalized px) per one workspace step. Higher = less
  // sensitive. One mouse notch ≈ 100, so this is ~one step per notch.
  const SENSITIVITY = 100;
  // Flip this to swap scroll direction (down = previous instead of next).
  const DOWN_IS_NEXT = true;

  const wf = () => window.workspacesFuncs;

  // Ordered workspace ids, read fresh so add/remove/reorder needs no reload.
  function workspaceOrder() {
    try {
      const store = JSON.parse(Services.prefs.getStringPref(STORE_PREF, "{}"));
      return Array.isArray(store.order) ? store.order : [];
    } catch (e) { return []; }
  }

  function currentWorkspaceId() {
    try { return wf()?.getSelectedWorkspaceID?.() ?? null; } catch (e) { return null; }
  }

  // Move `count` steps through the order (signed), clamped to [0, len-1] — so
  // scrolling past either end is a no-op (no wrap). One switch per call.
  function step(count) {
    const order = workspaceOrder();
    if (order.length < 2) return;               // nothing to switch between
    const cur = currentWorkspaceId();
    const i = order.indexOf(cur);
    if (i === -1) { console.warn("[ws-scroll] current id not in order:", cur); return; }
    const target = Math.max(0, Math.min(order.length - 1, i + count));
    if (target === i) return;                   // at an end → no wrap
    try {
      wf()?.changeWorkspace?.(order[target]);
      console.log(`[ws-scroll] → ${order[target]} (${i}→${target} of ${order.length - 1})`);
    } catch (e) { console.warn("[ws-scroll] changeWorkspace failed", e); }
  }

  function init() {
    let accum = 0; // accumulated wheel delta, so trackpads step smoothly too

    window.addEventListener("wheel", function (e) {
      if (!e.target?.closest?.("#" + BUTTON_ID)) return;
      e.preventDefault();   // don't let the toolbar scroll/consume it
      e.stopPropagation();

      // Dominant axis, normalized to ~pixels across deltaMode variants.
      let d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (e.deltaMode === 1) d *= 20;        // lines → px
      else if (e.deltaMode === 2) d *= 100;  // pages → px

      // Reset on direction reversal so a flick the other way responds at once.
      if ((d < 0) !== (accum < 0)) accum = 0;
      accum += d;

      let steps = 0;
      while (accum >= SENSITIVITY) { steps++; accum -= SENSITIVITY; }
      while (accum <= -SENSITIVITY) { steps--; accum += SENSITIVITY; }
      if (!steps) return;

      // +steps = scrolled down/right. Map to next/prev per DOWN_IS_NEXT.
      step(DOWN_IS_NEXT ? steps : -steps);
    }, { capture: true, passive: false });

    console.log("[ws-scroll] loaded");
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
