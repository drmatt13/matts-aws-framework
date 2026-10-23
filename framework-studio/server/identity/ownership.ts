import { EditError } from "../edits/io";

/** Intentional ownership refusal; safe to preserve through mutation review. */
export class ExternalCognitoReferenceError extends EditError {
  constructor() {
    super(403, "This deployment only references an externally managed retained User Pool. Studio user/group mutations are unavailable for this ownership scope. Use read-only inspection and separately authorize operations through the original pool owner's management workflow.");
  }
}
