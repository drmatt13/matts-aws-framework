import { ICONS, iconUrl, type IconKey } from "../icons";
import { cx } from "../ui/classes";

const iconSizes = {
  20: "size-5 flex-[0_0_20px]",
  22: "size-5.5 flex-[0_0_22px]",
  24: "size-6 flex-[0_0_24px]",
  26: "size-6.5 flex-[0_0_26px]",
  32: "size-8 flex-[0_0_32px]",
} as const;

/** Size belongs to the caller; badges and artwork stay owned by this component. */
export function EntityIcon({
  icon,
  badge,
  size = 26,
  badgeSize = 16,
  className,
}: {
  readonly icon: IconKey;
  readonly badge?: IconKey;
  readonly size?: keyof typeof iconSizes;
  readonly badgeSize?: 14 | 16;
  readonly className?: string;
}) {
  if (badge)
    return (
      <span data-entity-icon-wrap className={cx("relative inline-flex shrink-0", className)}>
        <EntityIcon icon={icon} size={size} />
        <img
          data-entity-badge
          className={cx(
            "absolute rounded-sm border border-[#506078] bg-[#17202d]",
            badgeSize === 14
              ? "-right-1 -bottom-1 size-3.5 p-px"
              : "-right-[5px] -bottom-[5px] size-4 p-0.5",
          )}
          src={iconUrl(badge)}
          alt={ICONS[badge][1]}
          title={ICONS[badge][1]}
        />
      </span>
    );
  return (
    <img
      data-entity-icon
      className={cx(
        iconSizes[size],
        "rounded-[3px] object-contain align-middle",
        ICONS[icon][0].startsWith("generic/") && "bg-[#243244] p-0.75",
        className,
      )}
      src={iconUrl(icon)}
      alt=""
      title={ICONS[icon][1]}
      aria-hidden
    />
  );
}
