import { withSourceWrite } from "../edits/source-gate";
import { AgentIntegrationError, integrateAgentProposal, type AgentIntegrationResult } from "./integration";
import { loadAgentProposal, loadAgentWorkspace, readDependencyDigest, type AgentProposal, type AgentWorkspace } from "./workspace";

/**
 * Source and installed dependencies are separate identities. The source importer
 * checks every saved source byte; this admission also binds its validation to
 * the installed dependency code captured for the task. It does not run package
 * scripts in the authoritative checkout, install dependencies, or use Git.
 */
export async function integrateApprovedAgentProposal(input: AgentWorkspace, proposalInput: AgentProposal, approvedDigest: string, options: {
  /** Trusted host hook only, never an HTTP-provided command or callback. */
  readonly afterInstall?: () => Promise<void>;
} = {}): Promise<AgentIntegrationResult> {
  const workspace = loadAgentWorkspace(input.directory), proposal = loadAgentProposal(proposalInput.directory);
  if (workspace.taskId !== input.taskId || workspace.repositoryRoot !== input.repositoryRoot || workspace.baseline.digest !== input.baseline.digest || workspace.dependencyDigest !== input.dependencyDigest
    || proposal.taskId !== workspace.taskId || proposal.repositoryRoot !== workspace.repositoryRoot || proposal.baselineDigest !== workspace.baseline.digest
    || proposal.digest !== proposalInput.digest || proposal.digest !== approvedDigest) {
    throw new AgentIntegrationError(409, "Approval no longer matches the captured workspace, dependency identity and frozen source proposal.");
  }
  const expected = workspace.dependencyDigest;
  if (!expected) throw new AgentIntegrationError(409, "This workspace has no captured installed dependency identity. Prepare and validate a fresh task before integration.");
  const unchangedDependencies = async (): Promise<void> => {
    if (await readDependencyDigest(workspace.repositoryRoot) !== expected) throw new AgentIntegrationError(409, "Installed project dependencies changed since the task was validated. Finish the installation, refresh the candidate and validate again.");
  };
  return withSourceWrite(workspace.repositoryRoot, async () => {
    // The shared gate excludes Studio's package/source writers. External npm or
    // editor processes remain optimistic observers, checked again below.
    await unchangedDependencies();
    return integrateAgentProposal(proposal, approvedDigest, { afterInstall: async () => {
      if (options.afterInstall) { await unchangedDependencies(); await options.afterInstall(); }
      await unchangedDependencies();
    } });
  });
}
