import { ICONS, iconUrl, type IconKey } from "../icons";

export function EntityIcon({ icon }: { readonly icon: IconKey }) {
  return <img className={`entity-icon ${ICONS[icon][0].startsWith("generic/") ? "generic-icon" : ""}`} src={iconUrl(icon)} alt="" title={ICONS[icon][1]} aria-hidden />;
}
