import { API_ROUTE } from "@repo/api-contract";

import JsonRequestPanel from "#/components/JsonRequestPanel";

export default function HttpLambdaPanel() {
  return (
    <JsonRequestPanel
      title="HTTP Lambda"
      description="Send a custom JSON payload to the authenticated Python example Lambda. Its contract accepts a string message."
      path={API_ROUTE["/examples/python"]}
      initialPayload={'{\n  "message": "Hello from the client app!"\n}'}
      buttonText="Invoke HTTP Lambda"
    />
  );
}
