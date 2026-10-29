export interface ChangeScope {
  primary: string[];
  auxiliary?: string[];
  forbidden?: string[];
}

export interface WorkspacePatchPlan {
  modified_files?: string[];
  added_files?: string[];
  deleted_files?: string[];
}
