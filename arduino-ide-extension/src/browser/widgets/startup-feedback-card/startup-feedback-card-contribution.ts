import {
  injectable,
  inject,
} from '@theia/core/shared/inversify';
import {
  FrontendApplicationContribution,
} from '@theia/core/lib/browser/frontend-application-contribution';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { StartupFeedbackCardWidget } from './startup-feedback-card-widget';
import { Widget } from '@theia/core/shared/@phosphor/widgets';
import { MessageLoop } from '@theia/core/shared/@phosphor/messaging';

@injectable()
export class StartupFeedbackCardContribution
  implements FrontendApplicationContribution
{
  @inject(FrontendApplicationStateService)
  private readonly appStateService: FrontendApplicationStateService;

  @inject(StartupFeedbackCardWidget)
  private readonly feedbackCardWidget: StartupFeedbackCardWidget;

  onStart(): void {
    // Wait for app to be ready before showing the card
    this.appStateService.reachedState('ready').then(() => {
      this.showFeedbackCard();
    });
  }

  private async showFeedbackCard(): Promise<void> {
    try {
      // Check if widget should be shown (not dismissed)
      const isDismissed = await this.feedbackCardWidget.isDismissed();
      
      if (isDismissed) {
        console.log('[StartupFeedbackCard] Card was previously dismissed, not showing');
        return;
      }

      console.log('[StartupFeedbackCard] Showing feedback card in bottom right corner');

      // Create overlay container in the bottom right corner
      const overlayContainer = document.createElement('div');
      overlayContainer.id = 'startup-feedback-card-overlay';
      overlayContainer.style.position = 'fixed';
      overlayContainer.style.bottom = '20px';
      overlayContainer.style.right = '20px';
      overlayContainer.style.zIndex = '10000';
      overlayContainer.style.pointerEvents = 'auto';
      document.body.appendChild(overlayContainer);

      // Attach the widget to the overlay container
      Widget.attach(this.feedbackCardWidget, overlayContainer);
      
      // Send resize message to ensure widget renders properly
      MessageLoop.sendMessage(this.feedbackCardWidget, Widget.ResizeMessage.UnknownSize);
      
      // Force the widget to update/render
      this.feedbackCardWidget.update();
      
      console.log('[StartupFeedbackCard] Feedback card attached and rendered');
    } catch (error) {
      console.error('[StartupFeedbackCard] Failed to show startup feedback card:', error);
    }
  }
}

