export interface InvocationTestStepEvent {
  message: string;
  taskId?: string;
  invokedBy?: string;
}

export interface InvocationTestStepResult {
  validatedBy: "invocation-test-step";
}

export const lambdaHandler = async (
  event: InvocationTestStepEvent,
): Promise<InvocationTestStepResult> => {
  if (!event.message) {
    throw new Error("message is required");
  }

  return {
    validatedBy: "invocation-test-step",
  };
};
