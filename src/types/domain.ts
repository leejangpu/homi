export type SpaceType = "personal" | "shared";
export type SpaceRole = "owner" | "editor" | "viewer";
export type ModuleType = "ledger" | "todo" | "diary" | "custom";
export type EntryType = "record" | "task" | "note";
export type LedgerFlowType = "income" | "expense";

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  createdAt: Date | null;
  updatedAt: Date | null;
  defaultSpaceId: string | null;
}

export interface Space {
  id: string;
  name: string;
  type: SpaceType;
  ownerUid: string;
  memberUids: string[];
  memberCount: number;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface SpaceMember {
  uid: string;
  role: SpaceRole;
  joinedAt: Date | null;
}

export interface ModuleInstance {
  id: string;
  spaceId: string;
  moduleType: ModuleType;
  title: string;
  description: string;
  createdBy: string;
  visibility: "space";
  isArchived: boolean;
  settings: Record<string, unknown>;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface ModuleEntry {
  id: string;
  moduleId: string;
  entryType: EntryType;
  eventAt: Date | null;
  payload: Record<string, unknown>;
  tags: string[];
  createdBy: string;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface LedgerEntryPayload {
  date: string;
  flowType: LedgerFlowType;
  category: string;
  detail: string;
  owner: string;
  amount: number;
  memo?: string;
  source?: string;
}

export interface LedgerEntryInput {
  date: string;
  flowType: LedgerFlowType;
  category: string;
  detail: string;
  amount: number;
  owner?: string;
  memo?: string;
  source?: string;
}
