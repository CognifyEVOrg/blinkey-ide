import React from '@theia/core/shared/react';
import {
  injectable,
  inject,
  postConstruct,
} from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { LocalStorageService } from '@theia/core/lib/browser/storage-service';
import { nls } from '@theia/core/lib/common/nls';
import { codicon } from '@theia/core/lib/browser';

export const STARTUP_FEEDBACK_CARD_STORAGE_KEY = 'arduino-ide:startup-feedback-card-dismissed';

@injectable()
export class StartupFeedbackCardWidget extends ReactWidget {
  static readonly ID = 'startup-feedback-card-widget';
  private dismissed: boolean | undefined = undefined;

  @inject(WindowService)
  private readonly windowService: WindowService;

  @inject(LocalStorageService)
  private readonly localStorageService: LocalStorageService;

  constructor() {
    super();
    this.id = StartupFeedbackCardWidget.ID;
    this.addClass('startup-feedback-card-widget');
    this.title.closable = false;
  }

  @postConstruct()
  protected init(): void {
    // Don't do async operations in postConstruct - do it lazily when needed
  }

  private async checkDismissed(): Promise<boolean> {
    if (this.dismissed !== undefined) {
      return this.dismissed;
    }
    // Check if user has dismissed the card
    const dismissed = await this.localStorageService.getData<boolean>(
      STARTUP_FEEDBACK_CARD_STORAGE_KEY
    );
    this.dismissed = dismissed === true;
    return this.dismissed;
  }

  async isDismissed(): Promise<boolean> {
    return await this.checkDismissed();
  }

  protected render(): React.ReactNode {
    // If dismissed state is not yet loaded, show loading state briefly
    // This will be updated once checkDismissed() completes
    if (this.dismissed === true) {
      return null;
    }

    return (
      <div className="startup-feedback-card">
        <div className="startup-feedback-card-header">
          <h3 className="startup-feedback-card-title">
            {nls.localize(
              'arduino/startupFeedback/title',
              'Help Us Improve!'
            )}
          </h3>
          <button
            className="startup-feedback-card-close"
            onClick={this.handleDismiss}
            title={nls.localize(
              'arduino/startupFeedback/close',
              'Dismiss'
            )}
          >
            <i className={codicon('close')} />
          </button>
        </div>
        <div className="startup-feedback-card-content">
          <p className="startup-feedback-card-message">
            {nls.localize(
              'arduino/startupFeedback/message',
              'Love Blinkey IDE? Star us on GitHub or share your feedback!'
            )}
          </p>
          <div className="startup-feedback-card-actions">
            <button
              className="theia-button startup-feedback-card-button primary"
              onClick={this.handleStarGitHub}
            >
              <i className={codicon('star')} />
              {nls.localize(
                'arduino/startupFeedback/starGitHub',
                'Star on GitHub'
              )}
            </button>
            <button
              className="theia-button startup-feedback-card-button secondary"
              onClick={this.handleProvideFeedback}
            >
              <i className={codicon('comment')} />
              {nls.localize(
                'arduino/startupFeedback/provideFeedback',
                'Provide Feedback'
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  private handleDismiss = async (): Promise<void> => {
    this.dismissed = true;
    await this.localStorageService.setData(STARTUP_FEEDBACK_CARD_STORAGE_KEY, true);
    
    // Remove the overlay container if it exists
    const overlay = document.getElementById('startup-feedback-card-overlay');
    if (overlay) {
      overlay.remove();
    }
    
    this.update();
  };

  private handleStarGitHub = (): void => {
    const githubUrl = 'https://github.com/CognifyEVOrg/arduino-ide';
    this.windowService.openNewWindow(githubUrl, { external: true });
    // Don't dismiss - let user close it manually if they want
  };

  private handleProvideFeedback = (): void => {
    // TODO: Replace 'YOUR_FORM_ID_HERE' with your actual Google Form ID
    // To get your form ID: Create a Google Form, then copy the ID from the form URL
    // Example: https://docs.google.com/forms/d/e/FORM_ID_HERE/viewform
    const feedbackFormUrl = 'https://forms.gle/YOUR_FORM_ID_HERE';
    this.windowService.openNewWindow(feedbackFormUrl, { external: true });
    // Don't dismiss - let user close it manually if they want
  };
}

