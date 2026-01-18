// @ts-check
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

// Add global error handlers to prevent silent crashes
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Log to a file if possible
  const errorLogPath = path.join(os.homedir(), '.blinkeyIDE', 'error.log');
  try {
    const logDir = path.dirname(errorLogPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    fs.appendFileSync(errorLogPath, `[${new Date().toISOString()}] Uncaught Exception: ${error.stack || error.message}\n`);
  } catch (logError) {
    // Ignore logging errors
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  const errorLogPath = path.join(os.homedir(), '.blinkeyIDE', 'error.log');
  try {
    const logDir = path.dirname(errorLogPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    fs.appendFileSync(errorLogPath, `[${new Date().toISOString()}] Unhandled Rejection: ${reason}\n`);
  } catch (logError) {
    // Ignore logging errors
  }
});

try {
  const config = require('./package.json').theia.frontend.config;
  // `buildDate` is only available in the bundled application.
  if (config.buildDate) {
    // `plugins` folder inside IDE2. IDE2 is shipped with these VS Code extensions. Such as cortex-debug, vscode-cpp, and translations.
    process.env.THEIA_DEFAULT_PLUGINS = `local-dir:${path.resolve(
      __dirname,
      'plugins'
    )}`;
    // `plugins` folder inside the `~/.cognifyIDE` folder. This is for manually installed VS Code extensions. For example, custom themes.
    // `plugins` folder inside the `~/.blinkeyIDE` folder. This is for manually installed VS Code extensions. For example, custom themes.
    process.env.THEIA_PLUGINS = [
      process.env.THEIA_PLUGINS,
      `local-dir:${path.resolve(os.homedir(), '.blinkeyIDE', 'plugins')}`,
    ]
      .filter(Boolean)
      .join(',');
  }

  const mainModulePath = './lib/backend/electron-main';
  const mainModuleFullPath = path.resolve(__dirname, mainModulePath);
  
  // Check if the main module exists
  if (!fs.existsSync(mainModuleFullPath + '.js')) {
    const errorMessage = `Main module not found: ${mainModuleFullPath}.js\n\n` +
      `This usually means the application was not built correctly.\n` +
      `Please rebuild the application using 'yarn build' before packaging.`;
    console.error(errorMessage);
    throw new Error(errorMessage);
  }

  require(mainModulePath);
} catch (error) {
  console.error('Failed to start Blinkey IDE:', error);
  // Try to show an error dialog if electron is available
  try {
    const { app, dialog } = require('electron');
    if (app && dialog) {
      app.whenReady().then(() => {
        dialog.showErrorBox(
          'Blinkey IDE - Startup Error',
          `Failed to start Blinkey IDE:\n\n${error.message}\n\n` +
          `Please check the error log at: ${path.join(os.homedir(), '.blinkeyIDE', 'error.log')}`
        );
        app.quit();
      });
    }
  } catch (electronError) {
    // Electron not available, just log the error
    console.error('Could not show error dialog:', electronError);
  }
  process.exit(1);
}
