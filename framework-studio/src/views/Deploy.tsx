import { CloudUpload } from "lucide-react";

export function Deploy() {
  return (
    <section className="placeholder-page" aria-labelledby="deploy-heading">
      <CloudUpload size={36} aria-hidden />
      <h1 id="deploy-heading">Deploy</h1>
      <p>Deployment controls are coming soon.</p>
    </section>
  );
}
