import type { SVGProps } from "react";

/*
 * Outline icons for the side panels. One grid (16px, 1.5 stroke, round
 * caps) so every glyph in the rails and rows has the same weight.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const FilesIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 1.75H4.5a1.25 1.25 0 0 0-1.25 1.25v10a1.25 1.25 0 0 0 1.25 1.25h7a1.25 1.25 0 0 0 1.25-1.25V5.5z" />
    <path d="M9 1.75V5.5h3.75" />
  </Icon>
);

export const BranchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="5" r="1.5" />
    <path d="M4.5 5v6" />
    <path d="M11.5 6.5c0 3-7 2.5-7 4.5" />
  </Icon>
);

export const GaugeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.25 11.5a5.75 5.75 0 1 1 11.5 0" />
    <path d="M8 11.5l2.75-3.5" />
    <circle cx="8" cy="11.5" r="0.75" />
  </Icon>
);

export const RefreshIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71" />
    <path d="M13.25 2.75v2.5h-2.5" />
  </Icon>
);

export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 3.25v9.5M3.25 8h9.5" />
  </Icon>
);

export const MinusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.25 8h9.5" />
  </Icon>
);

export const UndoIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5.5 3.75 2.75 6.5 5.5 9.25" />
    <path d="M2.75 6.5h6.5a3.5 3.5 0 0 1 0 7H7" />
  </Icon>
);

export const MoreIcon = (p: IconProps) => (
  <Icon {...p} strokeWidth="2.2">
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" />
  </Icon>
);

export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);

export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.25 10.25 3 3" />
  </Icon>
);

export const CollapseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 6.5 8 3.5l3 3M5 9.5l3 3 3-3" />
  </Icon>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 4 4 4-4 4" />
  </Icon>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m4 6 4 4 4-4" />
  </Icon>
);

export const FolderIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M1.75 4.5a1.25 1.25 0 0 1 1.25-1.25h3l1.5 1.75H13a1.25 1.25 0 0 1 1.25 1.25v5.75A1.25 1.25 0 0 1 13 13.25H3a1.25 1.25 0 0 1-1.25-1.25z" />
  </Icon>
);

export const FolderOpenIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M1.75 12V4.5a1.25 1.25 0 0 1 1.25-1.25h3l1.5 1.75H12a1.25 1.25 0 0 1 1.25 1.25V7" />
    <path d="M1.75 12 3.6 7.9a1.25 1.25 0 0 1 1.14-.73h9.01a.75.75 0 0 1 .69 1.04l-1.6 4.05a1.25 1.25 0 0 1-1.16.79H3" />
  </Icon>
);

export const FileIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 1.75H4.5a1.25 1.25 0 0 0-1.25 1.25v10a1.25 1.25 0 0 0 1.25 1.25h7a1.25 1.25 0 0 0 1.25-1.25V5.5z" />
    <path d="M9 1.75V5.5h3.75" />
  </Icon>
);

export const ArrowUpIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 12.75V3.25M4.25 7 8 3.25 11.75 7" />
  </Icon>
);

export const ArrowDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 3.25v9.5M4.25 9 8 12.75 11.75 9" />
  </Icon>
);

export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m3.25 8.25 3 3 6.5-6.5" />
  </Icon>
);

export const HistoryIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.75 8a5.25 5.25 0 1 0 1.54-3.71" />
    <path d="M2.75 2.75v2.5h2.5" />
    <path d="M8 5.25V8l2 1.25" />
  </Icon>
);
