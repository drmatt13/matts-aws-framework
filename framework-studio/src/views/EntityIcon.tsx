import { ICONS, iconUrl, type IconKey } from "../icons";

export function EntityIcon({ icon, badge }: { readonly icon: IconKey; readonly badge?: IconKey }) {
  if (badge) return <span className="entity-icon-wrap"><EntityIcon icon={icon} /><img className="entity-icon-badge" src={iconUrl(badge)} alt={ICONS[badge][1]} title={ICONS[badge][1]} /></span>;
  return <img className={`entity-icon ${ICONS[icon][0].startsWith("generic/") ? "generic-icon" : ""}`} src={iconUrl(icon)} alt="" title={ICONS[icon][1]} aria-hidden />;
}
