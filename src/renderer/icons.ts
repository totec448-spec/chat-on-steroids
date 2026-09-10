import Add01Icon from '@hugeicons/core-free-icons/Add01Icon';
import Activity01Icon from '@hugeicons/core-free-icons/Activity01Icon';
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon';
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon';
import ArrowUp02Icon from '@hugeicons/core-free-icons/ArrowUp02Icon';
import ArrowUpRight01Icon from '@hugeicons/core-free-icons/ArrowUpRight01Icon';
import BubbleChatIcon from '@hugeicons/core-free-icons/BubbleChatIcon';
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon';
import CancelCircleIcon from '@hugeicons/core-free-icons/CancelCircleIcon';
import Chart01Icon from '@hugeicons/core-free-icons/Chart01Icon';
import CheckListIcon from '@hugeicons/core-free-icons/CheckListIcon';
import Clock01Icon from '@hugeicons/core-free-icons/Clock01Icon';
import ComputerIcon from '@hugeicons/core-free-icons/ComputerIcon';
import Copy01Icon from '@hugeicons/core-free-icons/Copy01Icon';
import Delete02Icon from '@hugeicons/core-free-icons/Delete02Icon';
import File01Icon from '@hugeicons/core-free-icons/File01Icon';
import Folder01Icon from '@hugeicons/core-free-icons/Folder01Icon';
import Globe02Icon from '@hugeicons/core-free-icons/Globe02Icon';
import Image01Icon from '@hugeicons/core-free-icons/Image01Icon';
import Key01Icon from '@hugeicons/core-free-icons/Key01Icon';
import LockIcon from '@hugeicons/core-free-icons/LockIcon';
import Moon02Icon from '@hugeicons/core-free-icons/Moon02Icon';
import MoreHorizontalIcon from '@hugeicons/core-free-icons/MoreHorizontalIcon';
import PencilEdit02Icon from '@hugeicons/core-free-icons/PencilEdit02Icon';
import PlayIcon from '@hugeicons/core-free-icons/PlayIcon';
import Plug01Icon from '@hugeicons/core-free-icons/Plug01Icon';
import PowerServiceIcon from '@hugeicons/core-free-icons/PowerServiceIcon';
import ReloadIcon from '@hugeicons/core-free-icons/ReloadIcon';
import Search01Icon from '@hugeicons/core-free-icons/Search01Icon';
import Settings02Icon from '@hugeicons/core-free-icons/Settings02Icon';
import SidebarLeft01Icon from '@hugeicons/core-free-icons/SidebarLeft01Icon';
import Sun01Icon from '@hugeicons/core-free-icons/Sun01Icon';
import TerminalIcon from '@hugeicons/core-free-icons/TerminalIcon';
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon';
import ViewIcon from '@hugeicons/core-free-icons/ViewIcon';
import ZapIcon from '@hugeicons/core-free-icons/ZapIcon';

/**
 * Renderer icon authority.
 *
 * All application glyphs use Hugeicons' authored stroke geometry. The renderer only supplies
 * inherited `currentColor`; it never rewrites fill, stroke width, caps, joins or path data.
 */
type IconNode = readonly [
  tag: string,
  attrs: Readonly<Record<string, string | number>>,
  children?: readonly IconNode[]
];
type IconData = readonly IconNode[];

const hugeicons: Readonly<Record<string, IconData>> = {
  'i-mark': BubbleChatIcon,
  'i-sidebar': SidebarLeft01Icon,
  'i-bolt': ZapIcon,
  'i-steps': CheckListIcon,
  'i-pulse': ReloadIcon,
  'i-folder': Folder01Icon,
  'i-image': Image01Icon,
  'i-plus': Add01Icon,
  'i-eye': ViewIcon,
  'i-pencil': PencilEdit02Icon,
  'i-monitor': ComputerIcon,
  'i-globe': Globe02Icon,
  'i-terminal': TerminalIcon,
  'i-power': PowerServiceIcon,
  'i-lock': LockIcon,
  'i-copy': Copy01Icon,
  'i-retry': ReloadIcon,
  'i-check': Tick02Icon,
  'i-clock': Clock01Icon,
  'i-chev': ArrowRight01Icon,
  'i-down': ArrowDown01Icon,
  'i-up': ArrowUp02Icon,
  'i-out': ArrowUpRight01Icon,
  'i-trash': Delete02Icon,
  'i-x': Cancel01Icon,
  'i-ban': CancelCircleIcon,
  'i-play': PlayIcon,
  'i-key': Key01Icon,
  'i-sun': Sun01Icon,
  'i-moon': Moon02Icon,
  'i-more': MoreHorizontalIcon,
  'i-chat': BubbleChatIcon,
  'i-search': Search01Icon,
  'i-gear': Settings02Icon,
  'i-file': File01Icon
};

const sidebarIcons: Readonly<Record<string, IconData>> = {
  's-search': Search01Icon,
  's-usage': Chart01Icon,
  's-plugins': Plug01Icon,
  's-setup': CheckListIcon,
  's-agents': BubbleChatIcon,
  's-activity': Activity01Icon,
  's-settings': Settings02Icon
};

function attrName(name: string): string {
  if (name.includes('-')) return name;
  return name.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`);
}

function appendIconNodes(parent: SVGElement, data: IconData): void {
  for (const [tag, attrs, children] of data) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (name === 'key') continue;
      node.setAttribute(attrName(name), String(value));
    }
    if (children) appendIconNodes(node, children);
    parent.append(node);
  }
}

/** Installs the library-backed symbols before any dynamic renderer rows are built. */
export function installIconSprite(): void {
  const sprite = document.getElementById('iconSprite') as unknown as SVGElement | null;
  if (!sprite || sprite.namespaceURI !== 'http://www.w3.org/2000/svg' || sprite.dataset.ready === 'true') return;
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  for (const [id, data] of Object.entries({ ...hugeicons, ...sidebarIcons })) {
    const symbol = document.createElementNS('http://www.w3.org/2000/svg', 'symbol');
    symbol.id = id;
    symbol.setAttribute('viewBox', '0 0 24 24');
    appendIconNodes(symbol, data);
    defs.append(symbol);
  }
  sprite.replaceChildren(defs);
  sprite.dataset.ready = 'true';
}
