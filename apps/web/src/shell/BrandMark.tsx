/** Shared ndBrain ring mark: two overlapping ring outlines, used by both
 *  `AppShell`'s sidebar brand row and `LocalOnlyShell`'s header brand row so
 *  the two shells render the exact same logo instead of each carrying its
 *  own copy of the SVG (one of them used to fall back to a plain "◆" glyph).
 *
 *  Ring stroke colors are deliberately left to the caller via
 *  `ring1ClassName`/`ring2ClassName` (each shell's own CSS module) rather
 *  than hardcoded here — only the shape is shared, not any particular
 *  shell's color choice for it. */

export interface BrandMarkProps {
  /** Class for the `<svg>` itself, e.g. sizing/flex-shrink. */
  className?: string;
  /** Class for the near/left ring. */
  ring1ClassName?: string;
  /** Class for the far/right ring. */
  ring2ClassName?: string;
}

export function BrandMark({ className, ring1ClassName, ring2ClassName }: BrandMarkProps) {
  return (
    <svg className={className} width="22" height="17" viewBox="0 0 26 20" fill="none" aria-hidden="true">
      <circle className={ring1ClassName} cx="9.5" cy="10" r="6.5" strokeWidth="3" />
      <circle className={ring2ClassName} cx="16.5" cy="10" r="6.5" strokeWidth="3" />
    </svg>
  );
}
