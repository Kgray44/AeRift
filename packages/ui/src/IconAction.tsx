import type { ComponentProps } from "react";
import { Button, type ButtonProps } from "./components";
import { SpatialIcon } from "./SpatialScene";

type Props = Omit<ButtonProps, "children" | "title" | "aria-label" | "loadingLabel"> & {
  /** Use an action name, including the target where it would otherwise be ambiguous. */
  label: string;
  icon: ComponentProps<typeof SpatialIcon>["name"];
};

/** An icon shortcut, not a substitute for a labeled primary or consent action. */
export function IconAction({ label, icon, variant = "quiet", className = "", ...props }: Props) {
  return <Button {...props} className={`ae-icon-action ${className}`} variant={variant}
    title={label} aria-label={label} loadingLabel="">
    <SpatialIcon name={icon} size={19} />
  </Button>;
}
