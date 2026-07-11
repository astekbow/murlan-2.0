import { useEffect } from 'react';

/**
 * Keep the focused text field visible above the on-screen keyboard (the iPhone "I can't see what I'm
 * typing" problem — e.g. the DM-to-friend composer pinned at a dialog's bottom).
 *
 *  • Measures the keyboard height from `visualViewport` and exposes it as `--kb` on <html> + toggles a
 *    `kb-open` class. CSS uses these to shrink overlays/scrollers to the area ABOVE the keyboard
 *    (see `html.kb-open .modal-backdrop { bottom: var(--kb) }` in index.css), so a centered modal — and
 *    its bottom-anchored input — sits above the keyboard instead of behind it.
 *  • On focusing a text field, scrolls it into view once the keyboard has animated up (covers fields that
 *    live inside a scrollable pane: .pg-ls-scroll, the wallet/support page, a modal body).
 *
 * No-ops where `visualViewport` is unavailable — the layout just behaves as before.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;

    const isTextField = (el: EventTarget | null): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.isContentEditable) return true;
      if (el.tagName === 'TEXTAREA') return true;
      if (el instanceof HTMLInputElement) {
        return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'hidden'].includes(el.type);
      }
      return false;
    };

    let raf = 0;
    let kbOpen = false;
    const applyInset = () => {
      if (!vv) return;
      // Keyboard height ≈ how much shorter the visual viewport is than the layout viewport, from the bottom.
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty('--kb', `${Math.round(kb)}px`);
      const open = kb > 80; // ignore tiny insets (the collapsing URL bar, etc.)
      root.classList.toggle('kb-open', open);
      // When the keyboard CLOSES, undo any page scroll the reveal left behind (so the view doesn't stay
      // "stuck to the middle" after you finish typing). Only when the document actually scrolled.
      if (kbOpen && !open && window.scrollY > 0) window.scrollTo({ top: 0 });
      kbOpen = open;
    };
    const onViewport = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(applyInset); };

    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    const onFocusIn = (e: FocusEvent) => {
      if (!isTextField(e.target)) return;
      const el = e.target as HTMLElement;
      // Wait for the keyboard to open + the modal/scroller to re-measure, then bring the field into view —
      // but ONLY if a soft keyboard actually opened. Otherwise (desktop, or an already-visible field) the
      // center-scroll would needlessly jerk the page to the middle ("stuck in the middle" on focus).
      clearTimeout(revealTimer);
      revealTimer = setTimeout(() => {
        if (!root.classList.contains('kb-open')) return;
        try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* old browser */ }
      }, 320);
    };

    vv?.addEventListener('resize', onViewport);
    vv?.addEventListener('scroll', onViewport);
    document.addEventListener('focusin', onFocusIn);
    applyInset();

    return () => {
      vv?.removeEventListener('resize', onViewport);
      vv?.removeEventListener('scroll', onViewport);
      document.removeEventListener('focusin', onFocusIn);
      clearTimeout(revealTimer);
      cancelAnimationFrame(raf);
      root.classList.remove('kb-open');
      root.style.removeProperty('--kb');
    };
  }, []);
}
