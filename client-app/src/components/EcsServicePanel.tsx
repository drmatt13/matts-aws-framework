import { API_ROUTE } from "@repo/api-contract";

import JsonRequestPanel from "#/components/JsonRequestPanel";

export default function EcsServicePanel() {
  return (
    <JsonRequestPanel
      title="Services"
      description="Send a JSON payload to the example Express service's /greet route. It requires a name."
      note={
        <>
          Disabled by default in production deployments. The service runs only under
          Docker Compose because <code className="font-mono">exampleService</code> in
          framework.config.ts (declared in framework-config/services/example.ts) sets{" "}
          <code className="font-mono">deploy: "local-only"</code>. Change it to{" "}
          <code className="font-mono">"both"</code> to deploy it to AWS.
        </>
      }
      path={`${API_ROUTE["/example-service/*"]}/greet`}
      initialPayload={'{\n  "name": "client app"\n}'}
      buttonText="Invoke ECS service"
    />
  );
}
