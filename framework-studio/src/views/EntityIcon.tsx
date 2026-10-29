import { ICONS, iconUrl, type IconKey } from "../icons";
import { cx } from "../ui/classes";

export function EntityIcon({ icon, badge }: { readonly icon: IconKey; readonly badge?: IconKey }) {
  if (badge) return <span data-entity-icon-wrap className="relative inline-flex shrink-0"><EntityIcon icon={icon} /><img data-entity-badge className="absolute -right-[5px] -bottom-[5px] size-4 rounded-sm border border-[#506078] bg-[#17202d] p-[2px]" src={iconUrl(badge)} alt={ICONS[badge][1]} title={ICONS[badge][1]} /></span>;
  return <img data-entity-icon className={cx("size-[26px] flex-[0_0_26px] rounded-[3px] object-contain align-middle", ICONS[icon][0].startsWith("generic/") && "bg-[#243244] p-[3px]")} src={iconUrl(icon)} alt="" title={ICONS[icon][1]} aria-hidden />;
}
