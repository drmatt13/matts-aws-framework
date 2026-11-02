import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { dialogBodyClasses, dialogClasses, dialogHeaderClasses, dialogTitleClasses } from "../inspector-ui";
import { cx } from "../ui/classes";
import { IconButton } from "../ui/IconButton";

export function AwsProfileConfiguration({ onClose }: { readonly onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  const close = () => { dialog.current?.close(); onClose(); };
  return createPortal(<dialog ref={dialog} aria-labelledby={titleId} className={dialogClasses({ size: "unsaved" })}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header className={cx(dialogHeaderClasses, "flex items-center justify-between gap-4")}>
      <h2 id={titleId} className={dialogTitleClasses}>AWS profile configuration</h2>
      <IconButton autoFocus variant="quiet" aria-label="Close AWS profile configuration" onClick={close}><X size={16} aria-hidden /></IconButton>
    </header>
    <div className={dialogBodyClasses}>
      <p className="m-0 text-graphite">Placeholder</p>
    </div>
  </dialog>, document.body);
}
