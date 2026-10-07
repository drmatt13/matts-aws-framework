import { API_ROUTE } from "@repo/api-contract";

import JsonRequestPanel from "#/components/JsonRequestPanel";

export default function EcsServicePanel() {
  return (
    <JsonRequestPanel
      title="Services"
      description="Send a JSON payload to the example Express service's /greet route. It requires a name."
      path={`${API_ROUTE["/example-service/*"]}/greet`}
      initialPayload={'{\n  "name": "client app"\n}'}
      buttonText="Invoke ECS service"
    />
  );
}
