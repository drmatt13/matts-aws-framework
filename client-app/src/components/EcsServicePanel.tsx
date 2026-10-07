import { API_ROUTE } from "@repo/api-contract";

import JsonRequestPanel from "#/components/JsonRequestPanel";

export default function EcsServicePanel() {
  return (
    <JsonRequestPanel
      title="Services"
      description="Send a custom JSON payload to the LangGraph chat service. It requires a message and accepts optional threadId and resume fields."
      path={`${API_ROUTE["/langgraph/*"]}/chat`}
      initialPayload={'{\n  "message": "Hello from the client app!"\n}'}
      buttonText="Invoke ECS service"
    />
  );
}
