import { planResourceMove, planResourceRename, resourceReferenceIssues, type ResourceRenameResult } from "./naming-source";
import { namingProgramIndex } from "./naming-program";
import { buildSourceIndex, SourceFiles, type BuiltSourceIndex } from "./source";
import type { StudioState } from "./snapshot";
import type { NamingWorkerRequest, NamingWorkerReply } from "./naming-service";
import { continueCommentPositions, removedCommentPositions, reviewedComments, withCommentReview } from "./edits/comments";

// A disconnected owner cannot receive or approve a preview. In particular, do
// not leave a large TypeScript program alive after the Studio server closes.
process.once("disconnect", () => process.exit(0));
process.once("message", (request: NamingWorkerRequest) => {
  const reply = withCommentReview(request.root, request.commentOptions, () => {
  continueCommentPositions(request.removedPositions);
  const overrides = new Map(Object.entries(request.overrides));
  try {
    const built = request.operation.kind === "move"
      ? buildSourceIndex(request.root, request.snapshot.models.dev, new SourceFiles(overrides))
      : { index: request.snapshot.source, catalog: new Map(), exportStacks: [] } satisfies BuiltSourceIndex;
    const state = { snapshot: request.snapshot, built } as StudioState;
    let result: ResourceRenameResult;
    if (request.operation.kind === "rename") result = planResourceRename(request.root, state, request.operation.entity, request.operation.name, overrides);
    else if (request.operation.kind === "move") result = planResourceMove(request.root, state, request.operation.entity, request.operation.nextPath, overrides);
    else {
      const index = namingProgramIndex(request.root, overrides);
      result = { entityRemap: {}, issues: [...resourceReferenceIssues(request.root, state, request.operation.entity, overrides)], referenceCount: 0, sourceHashes: { ...index.hashes }, sourceFiles: [], sourceFingerprint: index.fingerprint };
    }
    return { result, overrides: Object.fromEntries(overrides), comments: reviewedComments(true), removedPositions: removedCommentPositions() } satisfies NamingWorkerReply;
  } catch {
    const source = request.snapshot.source.entities[request.operation.entity]?.value ?? { file: "framework-config/resources.ts", line: 1, column: 1, start: 0, end: 0 };
    return { result: { entityRemap: {}, issues: [{ message: "The resource reference worker could not complete this review. No source files were changed. Your draft is preserved; review again.", source }], referenceCount: 0, sourceHashes: {}, sourceFiles: [], sourceFingerprint: "" }, overrides: request.overrides, comments: reviewedComments(true), removedPositions: removedCommentPositions() } satisfies NamingWorkerReply;
  }
  });
  process.send?.(reply, () => process.exit(0));
});
