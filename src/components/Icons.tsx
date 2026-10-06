export {
  IconSidebarMinimalisticLinear as PanelIcon,
  IconChatRoundDotsLinear as ChatIcon,
  IconStarsMinimalisticLinear as SparkIcon,
  IconMagniferLinear as SearchIcon,
  IconBook2Linear as BookIcon,
  IconSettingsMinimalisticLinear as SettingsIcon,
  IconLinkSquareLinear as ExternalIcon,
  IconAddCircleLinear as PlusIcon,
  IconAltArrowRightLinear as ChevronRightIcon,
  IconMenuDotsLinear as MenuDotsIcon,
  IconRefreshLinear as RefreshIcon,
  IconCloseCircleLinear as CloseIcon,
  IconFolderLinear as FolderIcon,
  IconFolderOpenLinear as FolderOpenIcon,
  IconFileLinear as FileIcon,
  IconAltArrowDownLinear as ChevronDownIcon,
  IconDocumentsMinimalisticLinear as ExplorerIcon,
  IconBranchingPathsDownLinear as ChangesIcon,
  IconCopyLinear as CopyIcon,
} from "@ninzapp/solar-icons";

export function BlurIcon({
  active = false,
  className,
}: {
  active?: boolean;
  className?: string;
}) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v18" strokeDasharray="2 2" />
      <path
        d="M12 6a6 6 0 0 1 0 12"
        fill={active ? "currentColor" : "none"}
        opacity={active ? 0.75 : 0.3}
      />
      <circle
        cx="12"
        cy="12"
        r="3"
        fill={active ? "currentColor" : "none"}
        opacity={active ? 0.9 : 0.4}
      />
    </svg>
  );
}

