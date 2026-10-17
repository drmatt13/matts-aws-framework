/** Test-only handler for synthesis and the local runner's process-boundary tests. */
export const lambdaHandler = async (event: { readonly message: string }) => {
  if (!event.message) throw new Error("message is required");
  return { validatedBy: "validate-message" };
};
