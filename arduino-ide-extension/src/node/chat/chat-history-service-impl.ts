import { inject, injectable, named } from '@theia/core/shared/inversify';
import { ILogger } from '@theia/core/lib/common/logger';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ChatHistoryService,
  ChatHistoryError,
  Thread,
  ThreadSummary,
  ChatMessage,
} from '../../common/protocol/chat-history-service';
import { ConfigServiceImpl } from '../config-service-impl';
import {
  encryptChatData,
  decryptChatData,
  isEncrypted,
} from './chat-encryption';

const CHAT_DIR_NAME = '.blinky';
const CHAT_HISTORY_DIR = 'chat';
const THREADS_INDEX_FILE = 'threads.json';
const THREAD_FILE_PREFIX = 'thread-';

interface ThreadsIndex {
  threads: ThreadSummary[];
}

@injectable()
export class ChatHistoryServiceImpl implements ChatHistoryService {
  @inject(ILogger)
  @named('chat-history-service')
  private readonly logger: ILogger;

  @inject(ConfigServiceImpl)
  private readonly configService: ConfigServiceImpl;

  /**
   * Resolve the project root from a URI or use the current sketchbook.
   * Returns a normalized filesystem path.
   */
  private async resolveProjectRoot(projectRoot?: string): Promise<string> {
    if (projectRoot) {
      // Normalize the path
      return path.resolve(projectRoot);
    }

    // Try to get current sketch from sketches service
    // This is a fallback - ideally the frontend should always pass projectRoot
    const { config } = await this.configService.getConfiguration();
    if (config?.sketchDirUri) {
      return FileUri.fsPath(config.sketchDirUri);
    }

    throw ChatHistoryError.InvalidProjectRoot(
      'Could not determine project root. Please open a sketch or provide a project root.',
      projectRoot || 'unknown'
    );
  }

  /**
   * Get the chat history directory path for a project.
   */
  private getChatHistoryDir(projectRoot: string): string {
    return path.join(projectRoot, CHAT_DIR_NAME, CHAT_HISTORY_DIR);
  }

  /**
   * Get the threads index file path.
   */
  private getThreadsIndexPath(projectRoot: string): string {
    return path.join(this.getChatHistoryDir(projectRoot), THREADS_INDEX_FILE);
  }

  /**
   * Get the thread file path for a given thread ID.
   */
  private getThreadFilePath(projectRoot: string, threadId: string): string {
    return path.join(this.getChatHistoryDir(projectRoot), `${THREAD_FILE_PREFIX}${threadId}.json`);
  }

  /**
   * Ensure the chat history directory exists.
   */
  private async ensureChatHistoryDir(projectRoot: string): Promise<void> {
    const chatDir = this.getChatHistoryDir(projectRoot);
    try {
      await fs.mkdir(chatDir, { recursive: true });
    } catch (error) {
      this.logger.error(`Failed to create chat history directory: ${chatDir}`, error);
      throw ChatHistoryError.WriteFailed(
        `Failed to create chat history directory: ${error instanceof Error ? error.message : String(error)}`,
        chatDir
      );
    }
  }

  /**
   * Read the threads index file (encrypted).
   */
  private async readThreadsIndex(projectRoot: string): Promise<ThreadsIndex> {
    const indexPath = this.getThreadsIndexPath(projectRoot);
    try {
      const content = await fs.readFile(indexPath, 'utf-8');
      
      // Try to decrypt if encrypted, otherwise parse as plain JSON (migration)
      let decryptedContent: string;
      if (isEncrypted(content)) {
        try {
          decryptedContent = decryptChatData(content, projectRoot);
        } catch (decryptError) {
          this.logger.error(`Failed to decrypt threads index: ${indexPath}`, decryptError);
          throw ChatHistoryError.ReadFailed(
            `Failed to decrypt threads index: ${decryptError instanceof Error ? decryptError.message : String(decryptError)}`,
            indexPath
          );
        }
      } else {
        // Legacy unencrypted file - migrate it
        decryptedContent = content;
        // Re-encrypt and save
        try {
          const encrypted = encryptChatData(content, projectRoot);
          await fs.writeFile(indexPath, encrypted, 'utf-8');
        } catch (migrateError) {
          this.logger.warn(`Failed to migrate threads index to encrypted format: ${indexPath}`, migrateError);
        }
      }
      
      return JSON.parse(decryptedContent) as ThreadsIndex;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Index doesn't exist yet, return empty
        return { threads: [] };
      }
      this.logger.error(`Failed to read threads index: ${indexPath}`, error);
      throw ChatHistoryError.ReadFailed(
        `Failed to read threads index: ${error instanceof Error ? error.message : String(error)}`,
        indexPath
      );
    }
  }

  /**
   * Write the threads index file (encrypted).
   */
  private async writeThreadsIndex(projectRoot: string, index: ThreadsIndex): Promise<void> {
    const indexPath = this.getThreadsIndexPath(projectRoot);
    try {
      const jsonContent = JSON.stringify(index, null, 2);
      const encrypted = encryptChatData(jsonContent, projectRoot);
      await fs.writeFile(indexPath, encrypted, 'utf-8');
    } catch (error) {
      this.logger.error(`Failed to write threads index: ${indexPath}`, error);
      throw ChatHistoryError.WriteFailed(
        `Failed to write threads index: ${error instanceof Error ? error.message : String(error)}`,
        indexPath
      );
    }
  }

  /**
   * Read a thread file (encrypted).
   */
  private async readThreadFile(projectRoot: string, threadId: string): Promise<Thread> {
    const threadPath = this.getThreadFilePath(projectRoot, threadId);
    try {
      const content = await fs.readFile(threadPath, 'utf-8');
      
      // Try to decrypt if encrypted, otherwise parse as plain JSON (migration)
      let decryptedContent: string;
      if (isEncrypted(content)) {
        try {
          decryptedContent = decryptChatData(content, projectRoot);
        } catch (decryptError) {
          this.logger.error(`Failed to decrypt thread file: ${threadPath}`, decryptError);
          throw ChatHistoryError.ReadFailed(
            `Failed to decrypt thread: ${decryptError instanceof Error ? decryptError.message : String(decryptError)}`,
            threadPath
          );
        }
      } else {
        // Legacy unencrypted file - migrate it
        decryptedContent = content;
        // Re-encrypt and save
        try {
          const encrypted = encryptChatData(content, projectRoot);
          await fs.writeFile(threadPath, encrypted, 'utf-8');
        } catch (migrateError) {
          this.logger.warn(`Failed to migrate thread file to encrypted format: ${threadPath}`, migrateError);
        }
      }
      
      return JSON.parse(decryptedContent) as Thread;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw ChatHistoryError.NotFound(`Thread not found: ${threadId}`, threadId);
      }
      if (ChatHistoryError.ReadFailed.is(error)) {
        throw error;
      }
      this.logger.error(`Failed to read thread file: ${threadPath}`, error);
      throw ChatHistoryError.ReadFailed(
        `Failed to read thread: ${error instanceof Error ? error.message : String(error)}`,
        threadPath
      );
    }
  }

  /**
   * Write a thread file (encrypted).
   */
  private async writeThreadFile(projectRoot: string, thread: Thread): Promise<void> {
    const threadPath = this.getThreadFilePath(projectRoot, thread.id);
    try {
      const jsonContent = JSON.stringify(thread, null, 2);
      const encrypted = encryptChatData(jsonContent, projectRoot);
      await fs.writeFile(threadPath, encrypted, 'utf-8');
    } catch (error) {
      this.logger.error(`Failed to write thread file: ${threadPath}`, error);
      throw ChatHistoryError.WriteFailed(
        `Failed to write thread: ${error instanceof Error ? error.message : String(error)}`,
        threadPath
      );
    }
  }

  /**
   * Generate a title from the first user message.
   */
  private generateTitle(firstMessage: ChatMessage): string {
    const text = firstMessage.content.trim();
    // Take first sentence or first 60 characters
    const firstSentence = text.split(/[.!?]\s/)[0];
    if (firstSentence.length <= 60) {
      return firstSentence;
    }
    return text.substring(0, 57) + '...';
  }

  async listThreads(projectRoot?: string): Promise<ThreadSummary[]> {
    const resolvedRoot = await this.resolveProjectRoot(projectRoot);
    try {
      const index = await this.readThreadsIndex(resolvedRoot);
      // Sort by updatedAt descending (most recent first)
      return index.threads.sort((a, b) => 
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
    } catch (error) {
      // If directory doesn't exist, return empty list
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async createThread(projectRoot: string, initialMessage?: ChatMessage): Promise<Thread> {
    const resolvedRoot = await this.resolveProjectRoot(projectRoot);
    await this.ensureChatHistoryDir(resolvedRoot);

    const threadId = randomUUID();
    const now = new Date().toISOString();

    let title = 'New Chat';
    if (initialMessage && initialMessage.role === 'user') {
      title = this.generateTitle(initialMessage);
    }

    const thread: Thread = {
      projectRoot: resolvedRoot,
      id: threadId,
      title,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      messages: initialMessage ? [initialMessage] : [],
    };

    // Write thread file
    await this.writeThreadFile(resolvedRoot, thread);

    // Update index
    const index = await this.readThreadsIndex(resolvedRoot);
    const summary: ThreadSummary = {
      id: threadId,
      title,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      lastMessagePreview: initialMessage?.content.substring(0, 100),
    };
    index.threads.push(summary);
    await this.writeThreadsIndex(resolvedRoot, index);

    return thread;
  }

  async getThread(projectRoot: string, threadId: string): Promise<Thread> {
    const resolvedRoot = await this.resolveProjectRoot(projectRoot);
    return this.readThreadFile(resolvedRoot, threadId);
  }

  async appendMessage(projectRoot: string, threadId: string, message: ChatMessage): Promise<Thread> {
    const resolvedRoot = await this.resolveProjectRoot(projectRoot);
    const thread = await this.readThreadFile(resolvedRoot, threadId);

    // Add message
    thread.messages.push(message);
    thread.updatedAt = new Date().toISOString();

    // Update last message preview in index
    const index = await this.readThreadsIndex(resolvedRoot);
    const summary = index.threads.find(t => t.id === threadId);
    if (summary) {
      summary.updatedAt = thread.updatedAt;
      summary.lastMessagePreview = message.content.substring(0, 100);
    }

    // Write both files
    await this.writeThreadFile(resolvedRoot, thread);
    await this.writeThreadsIndex(resolvedRoot, index);

    return thread;
  }

  async renameThread(projectRoot: string, threadId: string, title: string): Promise<void> {
    const resolvedRoot = await this.resolveProjectRoot(projectRoot);
    const thread = await this.readThreadFile(resolvedRoot, threadId);

    thread.title = title;
    thread.updatedAt = new Date().toISOString();

    // Update index
    const index = await this.readThreadsIndex(resolvedRoot);
    const summary = index.threads.find(t => t.id === threadId);
    if (summary) {
      summary.title = title;
      summary.updatedAt = thread.updatedAt;
    }

    await this.writeThreadFile(resolvedRoot, thread);
    await this.writeThreadsIndex(resolvedRoot, index);
  }

  async archiveThread(projectRoot: string, threadId: string): Promise<void> {
    const resolvedRoot = await this.resolveProjectRoot(projectRoot);
    const thread = await this.readThreadFile(resolvedRoot, threadId);

    thread.status = 'archived';
    thread.updatedAt = new Date().toISOString();

    // Update index
    const index = await this.readThreadsIndex(resolvedRoot);
    const summary = index.threads.find(t => t.id === threadId);
    if (summary) {
      summary.status = 'archived';
      summary.updatedAt = thread.updatedAt;
    }

    await this.writeThreadFile(resolvedRoot, thread);
    await this.writeThreadsIndex(resolvedRoot, index);
  }

  async deleteThread(projectRoot: string, threadId: string): Promise<void> {
    const resolvedRoot = await this.resolveProjectRoot(projectRoot);

    // Remove from index
    const index = await this.readThreadsIndex(resolvedRoot);
    index.threads = index.threads.filter(t => t.id !== threadId);
    await this.writeThreadsIndex(resolvedRoot, index);

    // Delete thread file
    const threadPath = this.getThreadFilePath(resolvedRoot, threadId);
    try {
      await fs.unlink(threadPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`Failed to delete thread file: ${threadPath}`, error);
        // Don't throw - index is already updated
      }
    }
  }
}
