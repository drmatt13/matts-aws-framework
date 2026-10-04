import { BedrockAgentCoreControlClient, GetAgentRuntimeCommand, UpdateAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore-control";

const client = new BedrockAgentCoreControlClient({ maxAttempts: 3 });
export async function handler(event: { RequestType: string; PhysicalResourceId?: string; ResourceProperties: { RuntimeId: string } }) {
  const id = event.ResourceProperties.RuntimeId;
  if (event.RequestType === "Delete") return { PhysicalResourceId: event.PhysicalResourceId ?? id };
  const current = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId: id }));
  if (!current.metadataConfiguration?.requireMMDSV2) {
    await client.send(new UpdateAgentRuntimeCommand({ agentRuntimeId: id, roleArn: current.roleArn!, agentRuntimeArtifact: current.agentRuntimeArtifact, networkConfiguration: current.networkConfiguration, environmentVariables: current.environmentVariables, authorizerConfiguration: current.authorizerConfiguration, protocolConfiguration: current.protocolConfiguration, lifecycleConfiguration: current.lifecycleConfiguration, requestHeaderConfiguration: current.requestHeaderConfiguration, description: current.description, metadataConfiguration: { requireMMDSV2: true } }));
  }
  return { PhysicalResourceId: id };
}

export async function isComplete(event: { RequestType: string; ResourceProperties: { RuntimeId: string } }) {
  if (event.RequestType === "Delete") return { IsComplete: true };
  const current = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId: event.ResourceProperties.RuntimeId }));
  if (current.status?.endsWith("FAILED")) throw new Error("AgentCore runtime metadata update failed.");
  return { IsComplete: current.status === "READY" && current.metadataConfiguration?.requireMMDSV2 === true };
}
