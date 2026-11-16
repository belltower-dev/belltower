import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Eye,
  Globe,
  History,
  Info,
  List,
  Megaphone,
  Rss,
  Search,
  Target,
  TriangleAlert,
  Wrench,
} from "lucide"
import { escapeHtml } from "./markdown.ts"

/*
 * The page's icons: Lucide, the set shadcn/ui uses, inlined as SVG at
 * build so the page makes no requests for them. Always decorative: every
 * icon sits next to words that say the same thing.
 */

type IconNode = readonly (readonly [string, Readonly<Record<string, string | number | undefined>>])[]

const ICONS = {
  operational: CircleCheck,
  degraded: TriangleAlert,
  partial: CircleAlert,
  major: CircleX,
  maintenance: Wrench,
  nodata: CircleDashed,
  info: Info,
  notice: Megaphone,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  "arrow-right": ArrowRight,
  "arrow-left": ArrowLeft,
  feed: Rss,
  globe: Globe,
  clock: History,
  activity: Activity,
  target: Target,
  list: List,
  check: Check,
  search: Search,
  eye: Eye,
} satisfies Record<string, IconNode>

export type IconName = keyof typeof ICONS

function element([tag, attrs]: IconNode[number]): string {
  const attributes = Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeHtml(String(v))}"`)
    .join("")
  return `<${tag}${attributes}/>`
}

export function icon(name: IconName, cls = ""): string {
  return `<svg class="icon${cls ? ` ${cls}` : ""}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${(ICONS[name] as IconNode).map(element).join("")}</svg>`
}
