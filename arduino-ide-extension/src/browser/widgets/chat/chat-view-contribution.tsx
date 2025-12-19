import {
  injectable,
  inject,
} from '@theia/core/shared/inversify';
import {
  AbstractViewContribution,
  FrontendApplicationContribution,
} from '@theia/core/lib/browser';
import { CommandRegistry, Command } from '@theia/core/lib/common/command';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { ChatWidget, chatWidgetLabel } from './chat-widget';

export namespace ChatCommands {
  export const TOGGLE: Command = {
    id: ChatWidget.ID + ':toggle',
    label: chatWidgetLabel,
    category: 'View',
  };
}

@injectable()
export class ChatViewContribution extends AbstractViewContribution<ChatWidget> 
  implements FrontendApplicationContribution {
  static readonly TOGGLE_CHAT = ChatCommands.TOGGLE.id;

  @inject(FrontendApplicationStateService)
  protected readonly appStateService: FrontendApplicationStateService;

  @inject(EditorManager)
  protected readonly editorManager: EditorManager;

  constructor() {
    super({
      widgetId: ChatWidget.ID,
      widgetName: chatWidgetLabel,
      defaultWidgetOptions: {
        area: 'left',
        rank: 10, // Position in sidebar (higher = lower in list)
      },
      toggleCommandId: ChatViewContribution.TOGGLE_CHAT,
      toggleKeybinding: 'CtrlCmd+Shift+C',
    });
  }

  /**
   * Ensure the chat widget is created early so the sidebar icon appears immediately.
   * This is called when the application starts, before initializeLayout.
   */
  onStart(): void {
    // Wait for the app to be ready, then create the widget so the sidebar icon appears.
    // This ensures the icon is visible even in new windows before the widget is first opened.
    this.appStateService.reachedState('ready').then(() => {
      // Create the widget immediately so the sidebar icon appears right away.
      // We use openView with reveal:false to create the widget without showing it yet.
      this.openView({ activate: false, reveal: false }).catch((err) => {
        console.warn('Failed to create chat widget on startup:', err);
      });
    });

    // Listen for editor changes to refresh chat context
    this.editorManager.onCreated(() => {
      // Editor created - ensure chat widget is available and can update context
      this.openView({ activate: false, reveal: false }).catch((err) => {
        console.warn('Failed to create chat widget on editor creation:', err);
      });
    });
  }

  /**
   * Initialize the chat widget on startup to make the sidebar icon permanently visible.
   * This ensures the icon appears in the sidebar even before the user first opens the chat.
   * Each window will have its own chat widget instance (Theia creates separate application
   * instances for each Electron window). This method is called for each new window.
   */
  async initializeLayout(): Promise<void> {
    // Always create the widget so the sidebar icon is visible
    // The widget itself will handle showing appropriate messages when no project is open
    try {
      await this.openView({ activate: false, reveal: false });
    } catch (err) {
      console.warn('Failed to initialize chat widget layout:', err);
    }
  }

  /**
   * Register commands explicitly to ensure they appear in the keyboard shortcuts list.
   */
  override registerCommands(registry: CommandRegistry): void {
    super.registerCommands(registry);
    // The toggle command is already registered by AbstractViewContribution
    // We just need to ensure it's always enabled
    if (this.toggleCommand) {
      registry.registerCommand(this.toggleCommand, {
        execute: () => this.toggle(),
      });
    }
  }

  /**
   * Toggle the chat widget - open if closed, close if open.
   */
  protected async toggle(): Promise<void> {
    console.log('[ChatViewContribution] toggle() called');
    const widget = this.tryGetWidget();
    console.log('[ChatViewContribution] tryGetWidget() returned:', widget ? 'widget exists' : 'no widget');
    if (widget) {
      // Widget exists - toggle visibility
      console.log('[ChatViewContribution] Widget exists, isVisible:', widget.isVisible);
      if (widget.isVisible) {
        widget.hide();
      } else {
        await this.openView({ activate: true, reveal: true });
      }
    } else {
      // Widget doesn't exist - create and open it
      console.log('[ChatViewContribution] Widget does not exist, opening...');
      try {
        const openedWidget = await this.openView({ activate: true, reveal: true });
        console.log('[ChatViewContribution] openView() returned:', openedWidget ? 'widget opened' : 'no widget');
      } catch (error) {
        console.error('[ChatViewContribution] Failed to open chat widget:', error);
      }
    }
  }

  // Note: Keybinding is automatically registered by AbstractViewContribution
  // via the toggleKeybinding parameter in the constructor, so no need to
  // override registerKeybindings here.
}

