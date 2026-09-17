/**
 * The interface's icons, drawn rather than imported.
 *
 * One stroke for all of them — 1.5 on a 20-unit grid, round caps and joins — so
 * that a row of them reads as a set rather than as five libraries. `currentColor`
 * and no fill: an icon takes the colour of the control it sits in, in both
 * themes, and needs no variant of its own.
 *
 * Every icon is `aria-hidden`. The control around it carries the name, and an
 * icon that announced itself as well would have a screen reader say it twice.
 */

import type { ReactNode } from 'react';

interface IconProps {
  /** Rendered size in CSS pixels; the drawing is always on a 20-unit grid. */
  size?: number;
  className?: string;
}

function Svg({ size = 18, className, children }: IconProps & { children: ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

/** Two hemispheres with a fissure between them: the product's mark. */
export function BrainIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M9.3 3.6a2.6 2.6 0 0 0-4.6 1.2 2.7 2.7 0 0 0-1.9 3.8 2.8 2.8 0 0 0 .5 4.6 2.7 2.7 0 0 0 3.2 3.3 2.4 2.4 0 0 0 2.8.2V3.6Z" />
      <path d="M10.7 3.6a2.6 2.6 0 0 1 4.6 1.2 2.7 2.7 0 0 1 1.9 3.8 2.8 2.8 0 0 1-.5 4.6 2.7 2.7 0 0 1-3.2 3.3 2.4 2.4 0 0 1-2.8.2V3.6Z" />
      <path d="M6.2 7.4c.9 0 1.6.6 1.8 1.4M5.4 11.6c1 .2 1.7-.2 2.2-1M13.8 7.4c-.9 0-1.6.6-1.8 1.4M14.6 11.6c-1 .2-1.7-.2-2.2-1M7 14.4c.4-.7 1.1-1 1.8-.9M13 14.4c-.4-.7-1.1-1-1.8-.9" />
    </Svg>
  );
}

export function HomeIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3.5 8.6 10 3.5l6.5 5.1V16a1 1 0 0 1-1 1h-3.3v-4.4H7.8V17H4.5a1 1 0 0 1-1-1V8.6Z" />
    </Svg>
  );
}

/** Nodes and the lines between them. */
export function NetworkIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="2" />
      <circle cx="4.5" cy="4.5" r="1.5" />
      <circle cx="15.5" cy="4.5" r="1.5" />
      <circle cx="4.5" cy="15.5" r="1.5" />
      <circle cx="15.5" cy="15.5" r="1.5" />
      <path d="m5.6 5.6 3 3M14.4 5.6l-3 3M5.6 14.4l3-3M14.4 14.4l-3-3" />
    </Svg>
  );
}

/** A spark: tidying is making something shine again. */
export function SparkleIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M8.5 3c.4 3.4 1.9 4.9 5.3 5.3-3.4.4-4.9 1.9-5.3 5.3-.4-3.4-1.9-4.9-5.3-5.3 3.4-.4 4.9-1.9 5.3-5.3Z" />
      <path d="M15 12.2c.2 1.5.8 2.1 2.3 2.3-1.5.2-2.1.8-2.3 2.3-.2-1.5-.8-2.1-2.3-2.3 1.5-.2 2.1-.8 2.3-2.3Z" />
    </Svg>
  );
}

/** A ticked box. */
export function TasksIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3.5" y="3.5" width="13" height="13" rx="3" />
      <path d="m7 10.2 2.1 2.1L13.2 8" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="9" cy="9" r="5.2" />
      <path d="m13 13 3.6 3.6" />
    </Svg>
  );
}

/** A page with a folded corner: a note, and the files view. */
export function FileIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M11.5 2.8H6a1.5 1.5 0 0 0-1.5 1.5v11.4A1.5 1.5 0 0 0 6 17.2h8a1.5 1.5 0 0 0 1.5-1.5V6.8l-4-4Z" />
      <path d="M11.5 2.8v4h4M7.5 10.5h5M7.5 13.5h3.5" />
    </Svg>
  );
}

export function FolderIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M2.8 6V14.8A1.5 1.5 0 0 0 4.3 16.3h11.4a1.5 1.5 0 0 0 1.5-1.5V7.6a1.5 1.5 0 0 0-1.5-1.5H10L8.3 4H4.3a1.5 1.5 0 0 0-1.5 1.5Z" />
    </Svg>
  );
}

export function ChevronIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="m7.5 5 5 5-5 5" />
    </Svg>
  );
}

/** Two chevrons pointing left: fold the sidebar away. Mirrored in CSS to unfold. */
export function CollapseIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="m10 5.5-4.5 4.5 4.5 4.5M15 5.5 10.5 10l4.5 4.5" />
    </Svg>
  );
}

export function GearIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="2.4" />
      <path d="M10 2.8v1.8M10 15.4v1.8M17.2 10h-1.8M4.6 10H2.8M15.1 4.9l-1.3 1.3M6.2 13.8l-1.3 1.3M15.1 15.1l-1.3-1.3M6.2 6.2 4.9 4.9" />
      <circle cx="10" cy="10" r="5.2" />
    </Svg>
  );
}

export function SunIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="3.3" />
      <path d="M10 2.5v1.6M10 15.9v1.6M17.5 10h-1.6M4.1 10H2.5M15.3 4.7l-1.1 1.1M5.8 14.2l-1.1 1.1M15.3 15.3l-1.1-1.1M5.8 5.8 4.7 4.7" />
    </Svg>
  );
}

export function MoonIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M16.2 12.3A6.8 6.8 0 0 1 7.7 3.8a6.8 6.8 0 1 0 8.5 8.5Z" />
    </Svg>
  );
}

export function UserIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="7.2" />
      <circle cx="10" cy="8.3" r="2.6" />
      <path d="M5.3 15.4a5.5 5.5 0 0 1 9.4 0" />
    </Svg>
  );
}

export function ListIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M7.5 5.5h9M7.5 10h9M7.5 14.5h9" />
      <path d="M3.8 5.5h.01M3.8 10h.01M3.8 14.5h.01" strokeWidth="2" />
    </Svg>
  );
}

/** A globe: the map of the vault. */
export function MapIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="7" />
      <path d="M3 10h14M10 3c2 2 2.9 4.4 2.9 7S12 15 10 17c-2-2-2.9-4.4-2.9-7S8 5 10 3Z" />
    </Svg>
  );
}

export function ExpandIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4" />
    </Svg>
  );
}

export function ShrinkIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M7.5 3.5v4h-4M12.5 3.5v4h4M7.5 16.5v-4h-4M12.5 16.5v-4h4" />
    </Svg>
  );
}

export function NewNoteIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M11 3H6a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 6 17h8a1.5 1.5 0 0 0 1.5-1.5V8" />
      <path d="M15.5 2.5v4.5M13.2 4.8h4.6" />
    </Svg>
  );
}

export function NewFolderIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M2.8 14.8V5.5A1.5 1.5 0 0 1 4.3 4h4l1.7 2.1h5.7a1.5 1.5 0 0 1 1.5 1.5V9" />
      <path d="M2.8 14.8a1.5 1.5 0 0 0 1.5 1.5h6" />
      <path d="M15.2 11.5v5M12.7 14h5" />
    </Svg>
  );
}

export function ShareIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="14.5" cy="5" r="2" />
      <circle cx="5.5" cy="10" r="2" />
      <circle cx="14.5" cy="15" r="2" />
      <path d="m7.3 9 5.4-3M7.3 11l5.4 3" />
    </Svg>
  );
}

export function ShieldIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M10 2.8 4 5v4.6c0 3.7 2.5 6.4 6 7.6 3.5-1.2 6-3.9 6-7.6V5l-6-2.2Z" />
      <path d="m7.4 10 1.8 1.8 3.4-3.4" />
    </Svg>
  );
}

export function SignOutIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M8 16.5H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h3M13 13.5 16.5 10 13 6.5M16.5 10h-9" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="m5 5 10 10M15 5 5 15" />
    </Svg>
  );
}

export function MenuIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" />
    </Svg>
  );
}

/** A bin: deleting a note. */
export function TrashIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3.5 5.5h13M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5.2 5.5l.7 10.1a1.5 1.5 0 0 0 1.5 1.4h5.2a1.5 1.5 0 0 0 1.5-1.4l.7-10.1M8.5 9v4.5M11.5 9v4.5" />
    </Svg>
  );
}

/** Three points in a row: a menu of actions on one thing. */
export function MoreIcon(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M5 10h.01M10 10h.01M15 10h.01" strokeWidth="2.4" />
    </Svg>
  );
}
