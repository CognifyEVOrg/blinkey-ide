import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { FrontendApplication as TheiaFrontendApplication } from '@theia/core/lib/browser/frontend-application';
import { SketchesService } from '../../../common/protocol';
import { OpenSketchFiles } from '../../contributions/open-sketch-files';
import { URI } from '@theia/core/lib/common/uri';

@injectable()
export class FrontendApplication extends TheiaFrontendApplication {
  @inject(WorkspaceService)
  private readonly workspaceService: WorkspaceService;

  @inject(CommandService)
  private readonly commandService: CommandService;

  @inject(SketchesService)
  private readonly sketchesService: SketchesService;

  private layoutWasRestored = false;

  protected override async initializeLayout(): Promise<void> {
    await super.initializeLayout();
    try {
      const roots = await this.workspaceService.roots;
      console.log(`[FrontendApplication] Workspace roots resolved: ${roots.length} root(s)`);
      if (roots.length === 0) {
        console.log('[FrontendApplication] No workspace roots, creating new sketch...');
        // If no workspace, create a new sketch
        const sketch = await this.sketchesService.createNewSketch();
        this.workspaceService.open(new URI(sketch.uri), { preserveWindow: true });
        return;
      }
      for (const root of roots) {
        console.log(`[FrontendApplication] Opening sketch files for root: ${root.resource.toString()}`);
        try {
          await this.commandService.executeCommand(
            OpenSketchFiles.Commands.OPEN_SKETCH_FILES.id,
            root.resource,
            !this.layoutWasRestored
          );
          this.sketchesService.markAsRecentlyOpened(root.resource.toString()); // no await, will get the notification later and rebuild the menu
        } catch (err) {
          console.error(`[FrontendApplication] Error opening sketch files for ${root.resource.toString()}:`, err);
          // Continue with other roots even if one fails
        }
      }
    } catch (err) {
      console.error('[FrontendApplication] Error in initializeLayout:', err);
      // Try to create a fallback sketch
      try {
        const sketch = await this.sketchesService.createNewSketch();
        this.workspaceService.open(new URI(sketch.uri), { preserveWindow: true });
      } catch (fallbackErr) {
        console.error('[FrontendApplication] Failed to create fallback sketch:', fallbackErr);
      }
    }
  }

  protected override async restoreLayout(): Promise<boolean> {
    this.layoutWasRestored = await super.restoreLayout();
    return this.layoutWasRestored;
  }
}
