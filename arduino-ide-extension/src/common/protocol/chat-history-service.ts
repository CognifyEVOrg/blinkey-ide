import { ApplicationError } from '@theia/core/lib/common/application-error';

export namespace ChatHistoryError {
  export const Codes = {
    NotFound: 7001,
    InvalidProjectRoot: 7002,
    WriteFailed: 7003,
    ReadFailed: 7004,
  };
  export const NotFound = ApplicationError.declare(
    Codes.NotFound,
    (message: string, threadId: string) => {
      return {
        message,
        data: { threadId },
      };
    }
  );
  export const InvalidProjectRoot = ApplicationError.declare(
    Codes.InvalidProjectRoot,
    (message: string, projectRoot: string) => {
      return {
        message,
        data: { projectRoot },
      };
    }
  );
  export const WriteFailed = ApplicationError.declare(
    Codes.WriteFailed,
    (message: string, path: string) => {
      return {
        message,
        data: { path },
      };
    }
  );
  export const ReadFailed = ApplicationError.declare(
    Codes.ReadFailed,
    (message: string, path: string) => {
      return {
        message,
        data: { path },
      };
    }
  );
}

export const ChatHistoryServicePath = '/services/chat-history-service';
export const ChatHistoryService = Symbol('ChatHistoryService');

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string; // ISO timestamp
  metadata?: {
    codeBlocks?: string[];
    filesReferenced?: string[];
    toolsUsed?: string[];
    [key: string]: unknown;
  };
}

export interface ThreadSummary {
  id: string;
  title: string;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  status: 'active' | 'archived';
  lastMessagePreview?: string;
}

export interface Thread {
  projectRoot: string;
  id: string;
  title: string;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  status: 'active' | 'archived';
  messages: ChatMessage[];
  context?: {
    filesReferenced?: string[];
    toolsUsed?: string[];
    [key: string]: unknown;
  };
}

export interface ChatHistoryService {
  /**
   * List all threads for a project.
   * @param projectRoot - Canonical filesystem path to the project root. If not provided, uses current workspace.
   */
  listThreads(projectRoot?: string): Promise<ThreadSummary[]>;

  /**
   * Create a new thread for a project.
   * @param projectRoot - Canonical filesystem path to the project root.
   * @param initialMessage - Optional first message to add to the thread.
   */
  createThread(projectRoot: string, initialMessage?: ChatMessage): Promise<Thread>;

  /**
   * Get a full thread by ID.
   * @param projectRoot - Canonical filesystem path to the project root.
   * @param threadId - UUID of the thread.
   */
  getThread(projectRoot: string, threadId: string): Promise<Thread>;

  /**
   * Append a message to a thread.
   * @param projectRoot - Canonical filesystem path to the project root.
   * @param threadId - UUID of the thread.
   * @param message - Message to append.
   */
  appendMessage(projectRoot: string, threadId: string, message: ChatMessage): Promise<Thread>;

  /**
   * Rename a thread.
   * @param projectRoot - Canonical filesystem path to the project root.
   * @param threadId - UUID of the thread.
   * @param title - New title for the thread.
   */
  renameThread(projectRoot: string, threadId: string, title: string): Promise<void>;

  /**
   * Archive a thread (soft delete).
   * @param projectRoot - Canonical filesystem path to the project root.
   * @param threadId - UUID of the thread.
   */
  archiveThread(projectRoot: string, threadId: string): Promise<void>;

  /**
   * Delete a thread permanently.
   * @param projectRoot - Canonical filesystem path to the project root.
   * @param threadId - UUID of the thread.
   */
  deleteThread(projectRoot: string, threadId: string): Promise<void>;

  /**
   * Clear all messages from a thread (keeps the thread but removes all messages).
   * @param projectRoot - Canonical filesystem path to the project root.
   * @param threadId - UUID of the thread.
   */
  clearMessages(projectRoot: string, threadId: string): Promise<Thread>;
}
