import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href], select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]';

/** Locks page scroll, traps Tab inside the panel, closes on Escape and restores focus on unmount. */
export function useModal(panel: RefObject<HTMLElement | null>, onClose: () => void, initialFocus?: RefObject<HTMLElement | null>): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = setTimeout(() => (initialFocus?.current ?? panel.current)?.focus(), 0);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      } else if (event.key === 'Tab') {
        const targets = Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((element) => element.getClientRects().length > 0);
        const first = targets[0];
        const last = targets[targets.length - 1];
        if (!first || !last) { event.preventDefault(); panel.current?.focus(); return; }
        const active = document.activeElement as HTMLElement | null;
        if (!active || !targets.includes(active)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
        else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', keydown, true);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  // The panel and focus refs are stable for the lifetime of a dialog.
  }, []);
}
