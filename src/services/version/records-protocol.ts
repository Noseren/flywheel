/** A content-addressed file reference. Its meaning is owned by the calling Capability. */
export interface ArtifactRef {
  id: string;
  version: string;
  sha256: string;
  path?: string;
  externalRef?: string;
}

/** Mechanical pointer to one immutable record in a named collection. */
export interface ActiveRecordPointer {
  id: string;
  recordSha256: string;
  previousId?: string;
  updatedAt: string;
}

export interface VersionRecord {
  id: string;
}
