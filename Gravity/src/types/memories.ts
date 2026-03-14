export interface Memory {
  id: string;
  title: string;
  content: string;
  originNote: string | null;
  createdAt: string;
}

export interface CreateMemoryInput {
  title?: string;
  content: string;
  originNote?: string | null;
}

export interface UpdateMemoryInput {
  id: string;
  title?: string;
  content?: string;
}

export interface DeleteMemoryResult {
  success: boolean;
  id: string;
}
