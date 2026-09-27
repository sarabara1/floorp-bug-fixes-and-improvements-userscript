// ==UserScript==
// @name           stacktab-overflow-scroll-speed.uc.js
// @description    Stack strip: faster + smooth mouse-wheel scroll
// @include        main
// ==/UserScript==

// Speeds up wheel-scrolling of the overflowed tabs within a stack — the row that
// grows side arrow buttons and scrolls through the tabs when too many fit. This
// does NOT switch tabs; it only scrolls the strip.
//
// The element that actually scrolls is `#floorp-stack-scroller` (a horizontal
// hbox with overflowX; found live via a composedPath wheel probe). It is the
// PARENT of `#floorp-stack-items`, not the strip itself.
//
// Motion model: hand the scroll to Firefox's OWN native smooth-scroll engine via
// `scrollTo({ behavior: "smooth" })` — the exact mechanism the main tab strip
// uses. A probe of that global strip (composedPath sampler, §6) found it to be an
// `<scrollbox smoothscroll="true">` with CSS `scroll-behavior: smooth`, i.e. it
// just defers to Gecko's built-in smooth scroll. Sampling its motion showed a
// quick velocity ramp-up to a peak (~65ms) then a long drawn-out ease-OUT to rest
// (~250ms + tail) — the classic (non-MSD) model tuned by the user's prefs
// `general.smoothScroll.currentVelocityWeighting` (0.25) /
// `stopDecelerationWeighting` (0.4), duration clamped 50–200ms. (msdPhysics was
// FALSE.) By routing the stack strip through the SAME engine we inherit that feel
// by construction and track those prefs automatically, so it scrolls identically
// to the global tabs.
//
// This replaced a hand-rolled cubic-Hermite tween that, from a standstill, eased
// IN (m0 = 0 → smoothstep, a slow start) — the opposite of the native curve's
// fast-start-then-glide, and the "feels a bit wrong" this fixes. Several earlier
// curves (exponential, SmoothDamp, ease-in-out-quad, Hermite) were tried; the
// native engine's asymmetric long-tail ease-out is hard to reproduce by hand, so
// we stop trying and use it directly.
//
// Accumulation: we track our own `dest` (the accumulated target) and drive it
// with ABSOLUTE `scrollTo`, so rapid notches build distance reliably. A relative
// `scrollBy` mid-animation can restart from the lagging rendered position and
// undershoot; retargeting an absolute dest lets the native engine carry velocity
// into the new target (its currentVelocityWeighting), matching a fast global-strip
// spin. `dest` is re-read from the real scrollLeft whenever the pointer moves to
// another stack's scroller OR the strip has been idle longer than the max
// smooth-scroll duration — so an external scroll (tab select, add/remove) can't
// leave `dest` stale and cause a jump on the next notch.
//
// One knob:
//   - SPEED : distance per notch (sensitivity), a multiple of the raw delta.
//             Distance ONLY — the curve and duration come from the native engine
//             (and thus from the smoothScroll prefs), matching the global strip.

(function () {
  const SPEED = 4;        // distance per notch (sensitivity)
  const RESYNC_MS = 250;  // idle gap (ms) after which `dest` is re-read from
                          // reality; > smoothScroll.mouseWheel.durationMaxMS (200)

  function init() {
    let scroller = null;  // scroller we're currently driving
    let dest = 0;         // accumulated target scrollLeft
    let lastWheel = 0;    // timestamp (ms) of the previous handled wheel event

    window.addEventListener("wheel", function (e) {
      if (e.ctrlKey) return; // leave Ctrl+wheel (zoom) alone

      // composedPath() pierces shadow DOM, so this works whether or not the
      // stack UI lives inside a shadow root.
      const path = e.composedPath();
      let hit = path.find(
        n => n && n.nodeType === 1 && n.id === "floorp-stack-scroller"
      );
      // Wheeling over the overflow arrows / + button (siblings of the scroller in
      // #floorp-stack-bar, so NOT in the scroller's own subtree) should scroll too,
      // matching the global strip where the arrowscrollbox owns that whole area.
      // Resolve the scroller from the retained one, or find it under the bar.
      if (!hit) {
        const bar = path.find(
          n => n && n.nodeType === 1 && n.id === "floorp-stack-bar"
        );
        if (bar) hit = scroller || bar.querySelector?.("#floorp-stack-scroller");
      }
      if (!hit) return;

      const raw = e.deltaY || e.deltaX;
      if (!raw) return;

      // Normalize wheel units to pixels so SPEED is consistent across mice/OSes
      // reporting pixels (deltaMode 0), lines (1), or pages (2).
      let px = raw;
      if (e.deltaMode === 1) px *= 16;
      else if (e.deltaMode === 2) px *= hit.clientWidth;
      px *= SPEED;

      e.preventDefault();
      e.stopImmediatePropagation();

      const now = performance.now();
      // Re-read reality when we switch scrollers or after the animation has surely
      // settled (idle > RESYNC_MS); otherwise keep accumulating onto our tracked
      // dest so a fast spin builds distance ahead of the lagging rendered position.
      if (hit !== scroller || now - lastWheel > RESYNC_MS) {
        dest = hit.scrollLeft;
        scroller = hit;
      }
      lastWheel = now;

      const max = hit.scrollWidth - hit.clientWidth;
      dest = Math.max(0, Math.min(max, dest + px));

      // Native smooth scroll: same engine + same prefs as the global tab strip.
      hit.scrollTo({ left: dest, behavior: "smooth" });
    }, { capture: true, passive: false });

    console.log("[stack-wheel] loaded (native smooth scroll), SPEED =", SPEED);
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
