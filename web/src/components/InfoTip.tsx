import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A small "i" beside a label that explains what the label means.
 *
 * The explanation is drawn in a portal at a fixed position rather than as a
 * child of the label, because most labels live in a table header inside a
 * scrolling wrapper, and anything absolutely positioned there is clipped by
 * the wrapper's overflow.
 *
 * Opens on hover and keyboard focus, toggles on tap for touch screens, and
 * closes on Escape or a tap elsewhere. The text is also the button's
 * accessible description, so a screen reader hears it without opening it.
 */
export function InfoTip({ children, label }: { children: ReactNode; label?: string }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; below: boolean } | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setPinned(false);
  }, []);

  // Placed after the bubble has rendered, so its real size decides whether it
  // fits above the icon and how far it has to shift to stay on screen.
  useLayoutEffect(() => {
    if (!open || !button.current || !bubble.current) return;
    const anchor = button.current.getBoundingClientRect();
    const box = bubble.current.getBoundingClientRect();
    const gutter = 8;
    const below = anchor.top - box.height - gutter < 0;
    const top = below ? anchor.bottom + 6 : anchor.top - box.height - 6;
    const centred = anchor.left + anchor.width / 2 - box.width / 2;
    const left = Math.min(Math.max(gutter, centred), window.innerWidth - box.width - gutter);
    setPosition({ top, left, below });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onPointer = (event: PointerEvent) => {
      if (!button.current?.contains(event.target as Node)) close();
    };
    // A scroll moves the icon out from under a fixed bubble; closing is simpler
    // and less surprising than chasing it.
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open) setPosition(null);
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className="info-tip"
        aria-label={label ? `About ${label}` : 'More information'}
        aria-describedby={id}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => {
          if (!pinned) setOpen(false);
        }}
        onFocus={() => setOpen(true)}
        onBlur={close}
        onClick={(event) => {
          // Inside a sortable header or a clickable row, the tap is for the
          // explanation, not for the thing underneath it.
          event.preventDefault();
          event.stopPropagation();
          setPinned((current) => !current);
          setOpen(true);
        }}
      >
        i
      </button>
      {/* Always rendered (hidden when closed) so aria-describedby resolves. */}
      {createPortal(
        <div
          ref={bubble}
          id={id}
          role="tooltip"
          className={position?.below ? 'info-tip-bubble below' : 'info-tip-bubble'}
          hidden={!open}
          style={
            position
              ? { top: position.top, left: position.left }
              : { top: -9999, left: -9999 }
          }
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}
