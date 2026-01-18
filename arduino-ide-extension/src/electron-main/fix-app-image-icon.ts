import { environment } from '@theia/application-package/lib/environment';
import { isOSX, isWindows } from '@theia/core/lib/common/os';
import {
  ElectronMainApplication,
  ElectronMainApplicationContribution,
} from '@theia/core/lib/electron-main/electron-main-application';
import { injectable } from '@theia/core/shared/inversify';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

// Fixes no application icon for the AppImage on Linux (https://github.com/arduino/arduino-ide/issues/131)
// The fix was based on https://github.com/eclipse-theia/theia-blueprint/pull/180.
// Upstream: https://github.com/electron-userland/electron-builder/issues/4617
// Also sets the icon for Windows in development mode
@injectable()
export class FixAppImageIcon implements ElectronMainApplicationContribution {
  onStart(application: ElectronMainApplication): void {
    const windowOptions = application.config.electron.windowOptions;
    if (!windowOptions) {
      return;
    }

    // Skip macOS (it uses .icns files set by electron-builder)
    if (isOSX) {
      return;
    }

    // For Linux AppImage (production only)
    if (!isWindows && !environment.electron.isDevMode()) {
      if (windowOptions.icon === undefined) {
        const linuxIconPath = join(
          __dirname,
          '..',
          '..',
          'resources',
          'icons',
          'cognify-ide.png'
        );
        if (existsSync(linuxIconPath)) {
          windowOptions.icon = linuxIconPath;
        }
      }
      return;
    }

    // For Windows (dev and production)
    if (isWindows && windowOptions.icon === undefined) {
      // Try to find the icon in the electron-app/resources folder
      // In dev mode: electron-app/resources/icon.ico
      // In production: resources/icon.ico (relative to app root)
      const iconPaths = [
        // Development mode - relative to lib/electron-main
        join(__dirname, '..', '..', '..', 'electron-app', 'resources', 'icon.ico'),
        // Alternative dev path
        join(__dirname, '..', '..', '..', '..', 'electron-app', 'resources', 'icon.ico'),
        // Production mode
        join(process.resourcesPath || __dirname, 'app', 'resources', 'icon.ico'),
        join(__dirname, '..', '..', 'resources', 'icon.ico'),
      ];

      for (const iconPath of iconPaths) {
        if (existsSync(iconPath)) {
          windowOptions.icon = iconPath;
          console.log(`Setting window icon to: ${iconPath}`);
          break;
        }
      }

      // Also set the app icon for Windows (affects taskbar and window icon)
      if (windowOptions.icon && existsSync(windowOptions.icon)) {
        const { app } = require('@theia/core/electron-shared/electron');
        if (app && app.dock) {
          // macOS only
        } else if (app) {
          // On Windows, the app icon is typically set via electron-builder,
          // but we can also set it via the BrowserWindow icon option
          // The window icon should now be set in windowOptions
        }
      }
    }
  }
}
