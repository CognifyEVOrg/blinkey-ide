import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser';
import { Emitter, Event } from '@theia/core/lib/common/event';
import {
  ChatHistoryService,
  ChatHistoryServicePath,
  Thread,
  ThreadSummary,
  ChatMessage,
} from '../../../common/protocol/chat-history-service';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { SketchesService } from '../../../common/protocol/sketches-service';
import { FileUri } from '@theia/core/lib/common/file-uri';

@injectable()
export class ChatHistoryServiceClient {
  @inject(WebSocketConnectionProvider)
  protected readonly wsConnectionProvider: WebSocketConnectionProvider;

  @inject(FileService)
  protected readonly fileService: FileService;

  @inject(SketchesService)
  protected readonly sketchesService: SketchesService;

  protected service!: ChatHistoryService;

  protected readonly onThreadsChangedEmitter = new Emitter<ThreadSummary[]>();
  readonly onThreadsChanged: Event<ThreadSummary[]> = this.onThreadsChangedEmitter.event;

  protected readonly onActiveThreadChangedEmitter = new Emitter<Thread | undefined>();
  readonly onActiveThreadChanged: Event<Thread | undefined> = this.onActiveThreadChangedEmitter.event;

  protected currentProjectRoot: string | undefined;
  protected currentThreads: ThreadSummary[] = [];
  protected activeThread: Thread | undefined;

  @postConstruct()
  protected init(): void {
    this.service = this.wsConnectionProvider.createProxy<ChatHistoryService>(
      ChatHistoryServicePath
    );
  }

  /**
   * Get the current project root from the active sketch or workspace.
   */
  async resolveCurrentProjectRoot(): Promise<string | undefined> {
    try {
      // Try to get the current sketch
      const currentEditor = this.getCurrentEditorUri();
      if (currentEditor) {
        const sketch = await this.sketchesService.maybeLoadSketch(currentEditor);
        if (sketch) {
          return FileUri.fsPath(sketch.uri);
        }
      }

      // Fallback: try to get sketchbook root
      // This is a best-effort fallback - ideally the frontend should always have a sketch open
      return undefined;
    } catch (error) {
      console.warn('Failed to determine project root:', error);
      return undefined;
    }
  }

  /**
   * Get the URI of the currently active editor, if any.
   */
  private getCurrentEditorUri(): string | undefined {
    // This is a simplified approach - in a real implementation, you'd inject EditorManager
    // For now, we'll rely on the chat widget passing projectRoot explicitly
    return undefined;
  }

  /**
   * List threads for the current project.
   */
  async listThreads(projectRoot?: string): Promise<ThreadSummary[]> {
    const root = projectRoot || await this.resolveCurrentProjectRoot();
    if (!root) {
      return [];
    }

    try {
      const threads = await this.service.listThreads(root);
      this.currentProjectRoot = root;
      this.currentThreads = threads;
      this.onThreadsChangedEmitter.fire(threads);
      return threads;
    } catch (error) {
      console.error('Failed to list threads:', error);
      return [];
    }
  }

  /**
   * Create a new thread for the current project.
   */
  async createThread(projectRoot?: string, initialMessage?: ChatMessage): Promise<Thread> {
    const root = projectRoot || await this.resolveCurrentProjectRoot();
    if (!root) {
      throw new Error('Cannot create thread: no project root available');
    }

    const thread = await this.service.createThread(root, initialMessage);
    
    // Refresh thread list
    await this.listThreads(root);
    
    // Set as active thread
    this.setActiveThread(thread);
    
    return thread;
  }

  /**
   * Get a thread by ID.
   */
  async getThread(projectRoot: string, threadId: string): Promise<Thread> {
    return this.service.getThread(projectRoot, threadId);
  }

  /**
   * Append a message to a thread.
   */
  async appendMessage(
    projectRoot: string,
    threadId: string,
    message: ChatMessage
  ): Promise<Thread> {
    const thread = await this.service.appendMessage(projectRoot, threadId, message);
    
    // Update active thread if it's the same
    if (this.activeThread?.id === threadId) {
      this.activeThread = thread;
      this.onActiveThreadChangedEmitter.fire(thread);
    }
    
    // Refresh thread list to update last message preview
    await this.listThreads(projectRoot);
    
    return thread;
  }

  /**
   * Rename a thread.
   */
  async renameThread(projectRoot: string, threadId: string, title: string): Promise<void> {
    await this.service.renameThread(projectRoot, threadId, title);
    
    // Update active thread if it's the same
    if (this.activeThread?.id === threadId) {
      this.activeThread.title = title;
      this.onActiveThreadChangedEmitter.fire(this.activeThread);
    }
    
    // Refresh thread list
    await this.listThreads(projectRoot);
  }

  /**
   * Archive a thread.
   */
  async archiveThread(projectRoot: string, threadId: string): Promise<void> {
    await this.service.archiveThread(projectRoot, threadId);
    
    // Clear active thread if it's the one being archived
    if (this.activeThread?.id === threadId) {
      this.setActiveThread(undefined);
    }
    
    // Refresh thread list
    await this.listThreads(projectRoot);
  }

  /**
   * Delete a thread.
   */
  async deleteThread(projectRoot: string, threadId: string): Promise<void> {
    await this.service.deleteThread(projectRoot, threadId);
    
    // Clear active thread if it's the one being deleted
    if (this.activeThread?.id === threadId) {
      this.setActiveThread(undefined);
    }
    
    // Refresh thread list
    await this.listThreads(projectRoot);
  }

  /**
   * Set the active thread and load its messages.
   */
  async setActiveThread(thread: Thread | undefined): Promise<void> {
    this.activeThread = thread;
    this.onActiveThreadChangedEmitter.fire(thread);
  }

  /**
   * Load a thread and set it as active.
   */
  async loadThread(projectRoot: string, threadId: string): Promise<Thread> {
    const thread = await this.getThread(projectRoot, threadId);
    await this.setActiveThread(thread);
    return thread;
  }

  /**
   * Get the currently active thread.
   */
  getActiveThread(): Thread | undefined {
    return this.activeThread;
  }

  /**
   * Get the current project root.
   */
  getCurrentProjectRoot(): string | undefined {
    return this.currentProjectRoot;
  }

  /**
   * Clear state when switching projects.
   */
  clearState(): void {
    this.currentProjectRoot = undefined;
    this.currentThreads = [];
    this.activeThread = undefined;
    this.onThreadsChangedEmitter.fire([]);
    this.onActiveThreadChangedEmitter.fire(undefined);
  }
}
