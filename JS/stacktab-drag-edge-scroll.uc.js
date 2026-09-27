// ==UserScript==
// @name           stacktab-drag-edge-scroll.uc.js
// @description    Stack strip: auto-scroll (drag-to-edge + arrow click-hold)
// @include        main
// ==/UserScript==

// TWO continuous-scroll behaviors for the overflowed stack strip, both matching
// the GLOBAL tab strip (which gets them free from the arrowscrollbox widget the
// stack strip is NOT):
//   1. DRAG-TO-EDGE — dragging a tab near an edge auto-scrolls that way (below).
//   2. ARROW CLICK-HOLD — press & hold an overflow arrow to scroll continuously,
//      with a momentum glide on release (see the arrow section near the bottom).

// When you drag a stack tab to the left/right edge of an overflowed stack strip,
// the strip auto-scrolls in that direction — like a file manager, and like the
// GLOBAL tab strip already does. Floorp's global strip gets this free from the
// `arrowscrollbox` widget's built-in drag-scroll; the stack strip
// (`#floorp-stack-scroller`) is NOT an arrowscrollbox, so it has none — this adds
// it.
//
// The scroll container is the same `#floorp-stack-scroller` the wheel-speed script
// drives (its PARENT `#floorp-stack-items` doesn't overflow). Stack visual tabs
// are `draggable=true` (HTML5 DnD), so `dragover` fires with a live `clientX`
// during a drag — that's the pointer position we test against the scroller's edges.
//
// Motion: while the pointer sits within HOT px of an edge, a requestAnimationFrame
// loop advances `scrollLeft` by `dir * vel * dt` each frame (continuous, so it
// keeps scrolling even when the pointer is held STILL at the edge and `dragover`
// stops firing — the file-manager behavior). `vel` ramps with how deep the pointer
// is in the hot zone (V_MIN at the inner edge → V_MAX at the very edge); set
// V_MIN == V_MAX for a flat speed. The loop stops on drop/dragend, or as soon as a
// `dragover` lands outside the hot zone / off the strip (we listen on window, so
// leaving the strip fires one last dragover elsewhere that halts it).
//
// We do NOT preventDefault on dragover — auto-scroll doesn't need it, and staying
// out of the DnD contract leaves Floorp's own stack-reorder drop logic untouched.
//
// CALIBRATION (from a drag probe of the GLOBAL strip, §6): its scrollLeft stayed
// frozen while the pointer's distance-from-edge shrank 460→0 and only began
// moving the frame that distance went NEGATIVE — i.e. Firefox triggers when the
// pointer reaches/crosses the scrollbox edge (over the scroll-arrow BUTTON just
// outside it), not from an inner zone. Held at the edge it then glides at a flat
// ~20px every ~62ms ≈ 320 px/s, with NO ramp by depth. So V is flat 320 (a
// faithful match; native applies it as smooth 20px steps, we do it per-frame =
// smoother). HOT is a small INNER band instead of native's "past the edge": for a
// stack drag, chasing the pointer past the scroller edge risks leaving the strip
// and dropping `dragover`, so a slim inner zone gives the same at-the-edge trigger
// safely.
//
// Speed ramp (a deliberate deviation from native's flat rate, by preference):
// `into` climbs 0→1 as the pointer moves from the inner edge of the hot zone to
// the physical edge, so vel goes V_MIN (native steady state, where scrolling
// starts) → V_MAX (at the edge), then holds V_MAX over the arrows / past the edge.
// So it's gentle when you nudge to the side and quickest when you push right to
// the edge. Set V_MAX == V_MIN to restore native's flat rate.

(function () {
  const HOT = 32;      // edge hot-zone width, px (inner band; native triggers ~at edge)
  const V_MIN = 160;   // px/sec where scrolling starts (inner edge of the hot zone)
  const V_MAX = 1800;  // px/sec at the physical edge & beyond (ramp top; == V_MIN → flat)

  function init() {
    let scroller = null;     // scroller we're auto-scrolling
    let lastScroller = null; // most recent scroller seen (survives stop(), so we
                             // can keep scrolling when the pointer moves off the
                             // scroller onto a sibling arrow / + button)
    let dir = 0;             // -1 = left, +1 = right, 0 = idle
    let vel = 0;             // current auto-scroll speed, px/sec
    let raf = null;
    let lastT = 0;

    function loop(now) {
      if (!scroller || dir === 0) { raf = null; return; }
      const dt = lastT ? (now - lastT) / 1000 : 0;
      lastT = now;
      const max = scroller.scrollWidth - scroller.clientWidth;
      const next = Math.max(0, Math.min(max, scroller.scrollLeft + dir * vel * dt));
      scroller.scrollLeft = next;
      raf = requestAnimationFrame(loop);
    }

    function stop() {
      scroller = null; dir = 0; vel = 0; lastT = 0;
      if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
    }

    window.addEventListener("dragover", function (e) {
      // composedPath() pierces shadow DOM (the stack UI likely lives in one).
      const path = e.composedPath();
      const inScroller = path.find(
        n => n && n.nodeType === 1 && n.id === "floorp-stack-scroller"
      );
      // The overflow arrows and the + button are siblings of the scroller inside
      // #floorp-stack-bar, so they sit just PAST the scroller's edge — exactly
      // where native drag-scroll wants to keep scrolling. Treat being anywhere in
      // the bar as "still over the strip" and reuse the scroller we were driving,
      // so hovering an arrow doesn't halt the scroll (the geometry below clamps
      // past-the-edge to full speed).
      const inBar = path.find(
        n => n && n.nodeType === 1 && n.id === "floorp-stack-bar"
      );
      const hit = inScroller || (inBar
        && (lastScroller || inBar.querySelector?.("#floorp-stack-scroller")));
      if (!hit) { stop(); return; }
      lastScroller = hit;

      const max = hit.scrollWidth - hit.clientWidth;
      if (max <= 0) { stop(); return; } // strip isn't overflowing: nothing to do

      const rect = hit.getBoundingClientRect();
      const dL = e.clientX - rect.left;
      const dR = rect.right - e.clientX;

      let d = 0, into = 0;
      if (dL < HOT) { d = -1; into = (HOT - dL) / HOT; }   // near left edge
      else if (dR < HOT) { d = 1; into = (HOT - dR) / HOT; } // near right edge
      if (d === 0) { stop(); return; }                     // in the middle

      // Already pinned at that end → don't spin a pointless loop.
      if ((d < 0 && hit.scrollLeft <= 0) || (d > 0 && hit.scrollLeft >= max)) {
        stop(); return;
      }

      into = Math.max(0, Math.min(1, into)); // clamp (past-the-edge caps at V_MAX)
      scroller = hit;
      dir = d;
      vel = V_MIN + (V_MAX - V_MIN) * into;  // proximity ramp
      if (raf === null) { lastT = 0; raf = requestAnimationFrame(loop); }
    }, true);

    window.addEventListener("drop", stop, true);
    window.addEventListener("dragend", stop, true);

    // ===== Arrow click-hold: continuous scroll + release glide ================
    // A probe of the GLOBAL strip's scroll arrows (§6) showed: while the button is
    // held the strip scrolls at a DEAD-CONSTANT ~600 px/s (no acceleration), and
    // on release it GLIDES ~63px over ~420ms, decelerating to rest (the "physics"
    // feel — the smooth-scroll engine finishing its last target). We reproduce
    // that: constant ARROW_SPEED while held, then a quadratic ease-out coast whose
    // distance (v0·T/3) is tuned to ~64px. Self-contained (own scroller/dir/raf),
    // so it can't disturb the drag machinery above.
    //
    // We suppress the arrow's native single-step (mousedown + click) so a press
    // doesn't fire both; a quick tap then reduces to just the ~64px release glide,
    // which reads as one clean step — matching a single global-arrow click.
    const ARROW_SPEED = 600;   // px/sec while held (probe: constant 600)
    const ARROW_GLIDE = 0.32;  // sec of ease-out coast after release (~64px, native)

    let aScroller = null, aDir = 0, aRaf = null, aLastT = 0;
    let aCoast = false, aCoastT0 = 0, aCoastV0 = 0;

    function aStop() {
      aScroller = null; aDir = 0; aCoast = false; aLastT = 0;
      if (aRaf !== null) { cancelAnimationFrame(aRaf); aRaf = null; }
    }
    function aLoop(now) {
      if (!aScroller || aDir === 0) { aRaf = null; return; }
      const dt = aLastT ? (now - aLastT) / 1000 : 0;
      aLastT = now;
      let v = ARROW_SPEED;
      if (aCoast) {
        const p = (now - aCoastT0) / (ARROW_GLIDE * 1000);
        if (p >= 1) { aStop(); return; }
        const k = 1 - p; v = aCoastV0 * k * k;   // quadratic ease-out
      }
      const max = aScroller.scrollWidth - aScroller.clientWidth;
      const next = Math.max(0, Math.min(max, aScroller.scrollLeft + aDir * v * dt));
      aScroller.scrollLeft = next;
      if ((aDir < 0 && next <= 0) || (aDir > 0 && next >= max)) { aStop(); return; }
      aRaf = requestAnimationFrame(aLoop);
    }
    function aRelease() {                          // begin the coast (once)
      if (!aScroller || aCoast) return;
      aCoast = true; aCoastT0 = performance.now(); aCoastV0 = ARROW_SPEED;
    }

    window.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      const path = e.composedPath();
      const up = path.find(n => n && n.nodeType === 1 && n.id === "floorp-stack-scroll-up");
      const down = path.find(n => n && n.nodeType === 1 && n.id === "floorp-stack-scroll-down");
      if (!up && !down) return;
      // Scroller is a sibling of the arrow inside #floorp-stack-bar; find it in the
      // same (possibly shadow) root, falling back to the one drag last saw.
      const bar = path.find(n => n && n.nodeType === 1 && n.id === "floorp-stack-bar");
      const sc = bar?.querySelector?.("#floorp-stack-scroller") || lastScroller;
      if (!sc) return;

      e.preventDefault();
      e.stopPropagation();        // suppress the native single-step arrow action
      lastScroller = sc;
      aScroller = sc;
      aDir = up ? -1 : 1;
      aCoast = false; aLastT = 0;
      if (aRaf === null) aRaf = requestAnimationFrame(aLoop);
    }, true);

    // Swallow the follow-up click too, so a command-driven native arrow can't fire.
    window.addEventListener("click", function (e) {
      if (e.button !== 0) return;
      const path = e.composedPath();
      if (path.some(n => n && n.nodeType === 1 &&
          (n.id === "floorp-stack-scroll-up" || n.id === "floorp-stack-scroll-down"))) {
        e.stopPropagation();
      }
    }, true);

    window.addEventListener("mouseup", aRelease, true);
    window.addEventListener("blur", aStop, true); // released off-window → hard stop

    console.log("[stack-dragscroll] loaded, HOT =", HOT,
      "V =", V_MIN, "…", V_MAX, "| arrow-hold =", ARROW_SPEED, "px/s");
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
