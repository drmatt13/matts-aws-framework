import { useStudio } from "../studio";
import { openAwsProfileConfiguration } from "../aws-profile-queries";
import { Button } from "../ui/Button";
import { cx } from "../ui/classes";

/** The active declaration association supplies credentials; destinations remain explicit. */
export function AwsConnectionSummary({ className }: { readonly className?: string }) {
  const { mode, awsProfile } = useStudio();
  return (
    <div
      className={cx("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption", className)}
      data-slot="aws-connection-summary"
    >
      <span className="wrap-anywhere">
        Connection: <strong>{awsProfile || "Choose an AWS profile"}</strong> · selected for{" "}
        {mode === "dev" ? "Development" : "Production"}
      </span>
      <Button variant="link" size="compact" onClick={openAwsProfileConfiguration}>
        {awsProfile ? "Manage connection" : "Choose connection"}
      </Button>
    </div>
  );
}
