import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { isWindows } from '@theia/core/lib/common/os';
import yaml from 'js-yaml';
import { injectable, inject, named } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { ILogger } from '@theia/core/lib/common/logger';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { Event, Emitter } from '@theia/core/lib/common/event';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import {
  ConfigService,
  Config,
  NotificationServiceServer,
  Network,
  ConfigState,
} from '../common/protocol';
import { spawnCommand } from './exec-util';
import { ArduinoDaemonImpl } from './arduino-daemon-impl';
import { DefaultCliConfig, CLI_CONFIG, CliConfig } from './cli-config';
import { Deferred } from '@theia/core/lib/common/promise-util';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { deepClone, nls } from '@theia/core';
import { ErrnoException } from './utils/errors';
import { createArduinoCoreServiceClient } from './arduino-core-service-client';
import {
  ConfigurationSaveRequest,
  SettingsSetValueRequest,
} from './cli-protocol/cc/arduino/cli/commands/v1/settings_pb';

const deepmerge = require('deepmerge');

@injectable()
export class ConfigServiceImpl
  implements BackendApplicationContribution, ConfigService
{
  @inject(ILogger)
  @named('config')
  private readonly logger: ILogger;

  @inject(EnvVariablesServer)
  private readonly envVariablesServer: EnvVariablesServer;

  @inject(ArduinoDaemonImpl)
  private readonly daemon: ArduinoDaemonImpl;

  @inject(NotificationServiceServer)
  private readonly notificationService: NotificationServiceServer;

  private config: ConfigState = {
    config: undefined,
    messages: ['uninitialized'],
  };
  private cliConfig: DefaultCliConfig | undefined;
  private ready = new Deferred<void>();
  private readonly configChangeEmitter = new Emitter<{
    oldState: ConfigState;
    newState: ConfigState;
  }>();

  onStart(): void {
    this.initConfig();
  }

  private async getCliConfigFileUri(): Promise<string> {
    const configDirUri = await this.envVariablesServer.getConfigDirUri();
    return new URI(configDirUri).resolve(CLI_CONFIG).toString();
  }

  async getConfiguration(): Promise<ConfigState> {
    await this.ready.promise;
    return { ...this.config };
  }

  // Used by frontend to update the config.
  async setConfiguration(config: Config): Promise<void> {
    await this.ready.promise;
    if (Config.sameAs(this.config.config, config)) {
      return;
    }
    const oldConfigState = deepClone(this.config);
    let copyDefaultCliConfig: DefaultCliConfig | undefined = deepClone(
      this.cliConfig
    );
    if (!copyDefaultCliConfig) {
      copyDefaultCliConfig = await this.getFallbackCliConfig();
    }
    const { additionalUrls, dataDirUri, sketchDirUri, network, locale } =
      config;
    copyDefaultCliConfig.directories = {
      data: FileUri.fsPath(dataDirUri),
      user: FileUri.fsPath(sketchDirUri),
    };
    copyDefaultCliConfig.board_manager = {
      additional_urls: [...additionalUrls],
    };
    copyDefaultCliConfig.locale = locale || 'en';
    const proxy = Network.stringify(network);
    copyDefaultCliConfig.network = proxy ? { proxy } : {}; // must be an empty object to unset the default prop with the `WriteRequest`.

    // always use the port of the daemon
    const port = await this.daemon.getPort();
    await this.updateDaemon(port, copyDefaultCliConfig);
    await this.writeDaemonState(port);

    this.config.config = deepClone(config);
    this.cliConfig = copyDefaultCliConfig;
    try {
      await this.validateCliConfig(this.cliConfig);
      delete this.config.messages;
      this.fireConfigChanged(oldConfigState, this.config);
    } catch (err) {
      if (err instanceof InvalidConfigError) {
        this.config.messages = err.errors;
        this.fireConfigChanged(oldConfigState, this.config);
      } else {
        throw err;
      }
    }
  }

  get cliConfiguration(): DefaultCliConfig | undefined {
    return this.cliConfig;
  }

  get onConfigChange(): Event<{
    oldState: ConfigState;
    newState: ConfigState;
  }> {
    return this.configChangeEmitter.event;
  }

  private async initConfig(): Promise<void> {
    this.logger.info('>>> Initializing CLI configuration...');
    try {
      const cliConfig = await this.loadCliConfig();
      this.logger.info('Loaded the CLI configuration.');
      this.cliConfig = cliConfig;
      const [config] = await Promise.all([
        this.mapCliConfigToAppConfig(this.cliConfig),
        this.ensureUserDirExists(this.cliConfig).catch((reason) => {
          if (reason instanceof Error) {
            this.logger.warn(
              `Could not ensure user directory existence: ${this.cliConfig?.directories.user}`,
              reason
            );
          }
          // NOOP. Try to create the folder if missing but swallow any errors.
          // The validation will take care of the missing location handling.
        }),
      ]);
      this.config.config = config;
      this.logger.info(
        `Mapped the CLI configuration: ${JSON.stringify(this.config.config)}`
      );
      this.logger.info('Validating the CLI configuration...');
      await this.validateCliConfig(this.cliConfig);
      delete this.config.messages;
      this.logger.info('The CLI config is valid.');
      if (config) {
        this.ready.resolve();
        this.logger.info('<<< Initialized the CLI configuration.');
        return;
      }
    } catch (err: unknown) {
      this.logger.error('Failed to initialize the CLI configuration.', err);
      if (err instanceof InvalidConfigError) {
        this.config.messages = err.errors;
        this.ready.resolve();
      }
    }
  }

  private async loadCliConfig(
    initializeIfAbsent = true
  ): Promise<DefaultCliConfig> {
    const cliConfigFileUri = await this.getCliConfigFileUri();
    const cliConfigPath = FileUri.fsPath(cliConfigFileUri);
    this.logger.info(`Loading CLI configuration from ${cliConfigPath}...`);
    try {
      const content = await fs.readFile(cliConfigPath, {
        encoding: 'utf8',
      });
      let model = (yaml.load(content) || {}) as CliConfig;
      
      // Normalize any Arduino15 paths to .Blinkey in the loaded config
      let normalizedData = model.directories?.data;
      let normalizedUser = model.directories?.user;
      let configChanged = false;
      const homeDir = os.homedir();
      
      if (model.directories?.data) {
        const dataPath = model.directories.data;
        const dataPathLower = dataPath.toLowerCase();
        if (dataPathLower.includes('arduino15')) {
          let defaultArduino15Path: string;
          let blinkey15Path: string;
          
          if (isWindows) {
            defaultArduino15Path = join(homeDir, 'AppData', 'Local', 'Arduino15');
            blinkey15Path = join(homeDir, 'AppData', 'Local', '.Blinkey');
          } else {
            defaultArduino15Path = join(homeDir, '.arduino15');
            blinkey15Path = join(homeDir, '.Blinkey');
          }
          
          if (dataPath === defaultArduino15Path) {
            normalizedData = blinkey15Path;
          } else {
            normalizedData = dataPath.replace(/Arduino15/gi, '.Blinkey').replace(/arduino15/gi, '.Blinkey');
          }
          configChanged = true;
          this.logger.info(`Normalized data directory path from ${dataPath} to ${normalizedData}`);
        }
      }
      
      if (model.directories?.user) {
        const userPath = model.directories.user;
        let defaultArduinoPath: string;
        let blinkeyPath: string;
        
        if (isWindows) {
          defaultArduinoPath = join(homeDir, 'Documents', 'Arduino');
          blinkeyPath = join(homeDir, 'Documents', 'Blinkey');
        } else {
          defaultArduinoPath = join(homeDir, 'Arduino');
          blinkeyPath = join(homeDir, 'Blinkey');
        }
        
        if (userPath === defaultArduinoPath) {
          normalizedUser = blinkeyPath;
          configChanged = true;
          this.logger.info(`Normalized user directory path from ${userPath} to ${blinkeyPath}`);
        }
      }
      
      // Create new model with normalized paths if changes were made
      if (configChanged && normalizedData && normalizedUser) {
        model = {
          ...model,
          directories: {
            ...model.directories,
            data: normalizedData,
            user: normalizedUser,
          },
        };
      }
      
      this.logger.info(`Loaded CLI configuration: ${JSON.stringify(model)}`);
      if (model.directories?.data && model.directories?.user) {
        this.logger.info(
          "'directories.data' and 'directories.user' are set in the CLI configuration model."
        );
        // Write normalized config back to file to persist the changes
        if (configChanged) {
          try {
            await fs.writeFile(cliConfigPath, yaml.dump(model), { encoding: 'utf-8' });
            this.logger.info(`Persisted normalized Blinkey paths to ${cliConfigPath}`);
          } catch (writeError) {
            this.logger.warn('Could not persist normalized config:', writeError);
          }
        }
        return model as DefaultCliConfig;
      }
      // The CLI can run with partial (missing `port`, `directories`), the IDE2 cannot.
      // We merge the default CLI config with the partial user's config.
      this.logger.info(
        "Loading fallback CLI configuration to get 'directories.data' and 'directories.user'"
      );
      const fallbackModel = await this.getFallbackCliConfig();
      this.logger.info(
        `Loaded fallback CLI configuration: ${JSON.stringify(fallbackModel)}`
      );
      const mergedModel = deepmerge(fallbackModel, model) as DefaultCliConfig;
      this.logger.info(
        `Merged CLI configuration with the fallback: ${JSON.stringify(
          mergedModel
        )}`
      );
      
      // IMPORTANT: Write the merged config back to file to ensure directories are persisted
      // This prevents arduino-cli from using Arduino15 defaults when called directly
      try {
        // Write YAML directly to ensure directories are in the file
        await fs.writeFile(cliConfigPath, yaml.dump(mergedModel), { encoding: 'utf-8' });
        this.logger.info(`Persisted merged CLI configuration with Blinkey paths to ${cliConfigPath}`);
      } catch (writeError) {
        this.logger.warn('Could not persist merged config to file (will use in-memory config):', writeError);
      }
      
      return mergedModel;
    } catch (error) {
      if (ErrnoException.isENOENT(error)) {
        if (initializeIfAbsent) {
          await this.initCliConfigTo(dirname(cliConfigPath));
          return this.loadCliConfig(false);
        }
      }
      throw error;
    }
  }

  private async getFallbackCliConfig(): Promise<DefaultCliConfig> {
    const cliPath = this.daemon.getExecPath();
    const cliConfigFileUri = await this.getCliConfigFileUri();
    const cliConfigPath = FileUri.fsPath(cliConfigFileUri);
    
    // IMPORTANT: Use --config-file flag to ensure we're reading from the correct config file
    const [configRaw, directoriesRaw] = await Promise.all([
      spawnCommand(cliPath, ['config', 'dump', '--config-file', cliConfigPath, '--json']),
      // Since CLI 1.0, the command `config dump` only returns user-modified values and not default ones.
      // directories.user and directories.data are required by IDE2 so we get the default value explicitly.
      spawnCommand(cliPath, ['config', 'get', 'directories', '--config-file', cliConfigPath, '--json']),
    ]);

    const config = JSON.parse(configRaw);
    let { user, data } = JSON.parse(directoriesRaw);

    // Replace default Arduino paths with Blinkey (platform-aware)
    const homeDir = os.homedir();
    let defaultArduinoPath: string;
    let blinkeyPath: string;
    let defaultArduino15Path: string;
    let blinkey15Path: string;
    
    if (isWindows) {
      // Windows: Documents\Arduino -> Documents\Blinkey
      defaultArduinoPath = join(homeDir, 'Documents', 'Arduino');
      blinkeyPath = join(homeDir, 'Documents', 'Blinkey');
      // Windows: AppData\Local\Arduino15 -> AppData\Local\.Blinkey
      defaultArduino15Path = join(homeDir, 'AppData', 'Local', 'Arduino15');
      blinkey15Path = join(homeDir, 'AppData', 'Local', '.Blinkey');
    } else {
      // Linux/Mac: ~/Arduino -> ~/Blinkey
      defaultArduinoPath = join(homeDir, 'Arduino');
      blinkeyPath = join(homeDir, 'Blinkey');
      // Linux/Mac: ~/.arduino15 -> ~/.Blinkey
      defaultArduino15Path = join(homeDir, '.arduino15');
      blinkey15Path = join(homeDir, '.Blinkey');
    }
    
    // Replace sketchbook path
    if (user === defaultArduinoPath) {
      user = blinkeyPath;
      this.logger.info(`Changed default sketchbook path from ${defaultArduinoPath} to ${blinkeyPath}`);
    }
    
    // Replace data directory path (where libraries are stored)
    // Check if data path contains Arduino15 (case-insensitive) or matches the default Arduino15 path
    let dataPathChanged = false;
    const dataLower = data.toLowerCase();
    if (data === defaultArduino15Path || dataLower.includes('arduino15')) {
      const originalDataPath = data;
      // Replace Arduino15 with .Blinkey in the path, preserving the parent directory structure
      data = data.replace(/Arduino15/gi, '.Blinkey').replace(/arduino15/gi, '.Blinkey');
      // Ensure we use the platform-specific path if replacement didn't work as expected
      if (data === originalDataPath) {
        data = blinkey15Path;
      }
      this.logger.info(`Changed default data directory from ${originalDataPath} to ${data}`);
      dataPathChanged = true;
    }

    const userPathChanged = user === defaultArduinoPath;
    
    const fallbackConfig = { ...config.config, directories: { user, data } };
    
    // IMPORTANT: If we detected and fixed Arduino15 paths, immediately write them to the config file
    // This prevents arduino-cli from creating .arduino15 folders when downloading boards
    if (userPathChanged || dataPathChanged) {
      try {
        // Use arduino-cli config set to update the file (ensures proper formatting)
        if (userPathChanged) {
          await spawnCommand(cliPath, ['config', 'set', 'directories.user', user, '--config-file', cliConfigPath]);
        }
        if (dataPathChanged) {
          await spawnCommand(cliPath, ['config', 'set', 'directories.data', data, '--config-file', cliConfigPath]);
        }
        this.logger.info(`Persisted corrected Blinkey paths to config file: ${cliConfigPath}`);
      } catch (writeError) {
        this.logger.warn('Could not persist corrected paths to config file:', writeError);
        // Fallback: write YAML directly
        try {
          await fs.writeFile(cliConfigPath, yaml.dump(fallbackConfig), { encoding: 'utf-8' });
          this.logger.info(`Persisted corrected Blinkey paths via direct YAML write`);
        } catch (yamlWriteError) {
          this.logger.warn('Could not write corrected config via YAML either:', yamlWriteError);
        }
      }
    }

    return fallbackConfig;
  }

  private async initCliConfigTo(fsPathToDir: string): Promise<void> {
    const cliPath = this.daemon.getExecPath();
    const cliConfigFileUri = await this.getCliConfigFileUri();
    const cliConfigPath = FileUri.fsPath(cliConfigFileUri);
    
    // CRITICAL: Create config file ourselves with Blinkey paths to prevent .arduino15 creation
    // Don't use 'config init' as it creates directories with default Arduino paths
    const homeDir = os.homedir();
    let blinkeyPath: string;
    let blinkey15Path: string;
    
    if (isWindows) {
      // Windows: Documents\Blinkey
      blinkeyPath = join(homeDir, 'Documents', 'Blinkey');
      // Windows: AppData\Local\.Blinkey
      blinkey15Path = join(homeDir, 'AppData', 'Local', '.Blinkey');
    } else {
      // Linux/Mac: ~/Blinkey
      blinkeyPath = join(homeDir, 'Blinkey');
      // Linux/Mac: ~/.Blinkey
      blinkey15Path = join(homeDir, '.Blinkey');
    }
    
    // Create config file directly with Blinkey paths
    const initialConfig: CliConfig = {
      directories: {
        user: blinkeyPath,
        data: blinkey15Path,
      },
    };
    
    // Ensure the directory exists
    await fs.mkdir(fsPathToDir, { recursive: true });
    
    // Write the config file with correct paths from the start
    await fs.writeFile(cliConfigPath, yaml.dump(initialConfig), { encoding: 'utf8' });
    this.logger.info(`Created config file with Blinkey paths at ${cliConfigPath} to prevent .arduino15 creation`);
    
    // Verify with CLI that the config is valid (but don't let it modify it)
    try {
      await spawnCommand(cliPath, ['config', 'dump', '--config-file', cliConfigPath, '--json']);
      this.logger.info('Config file validated by CLI');
    } catch (error) {
      this.logger.warn('CLI validation failed, but config file created with Blinkey paths:', error);
    }
    
    // Calculate paths for comparison (no longer needed but kept for compatibility)
    let defaultArduinoPath: string;
    let defaultArduino15Path: string;
    
    if (isWindows) {
      defaultArduinoPath = join(homeDir, 'Documents', 'Arduino');
      defaultArduino15Path = join(homeDir, 'AppData', 'Local', 'Arduino15');
    } else {
      defaultArduinoPath = join(homeDir, 'Arduino');
      defaultArduino15Path = join(homeDir, '.arduino15');
    }
    
    // IMPORTANT: Use --config-file flag to ensure we're updating the correct config file
    // that the daemon will use, not a global or default config file
    
    // Set sketchbook path to Blinkey
    try {
      // Read config file directly to avoid triggering CLI directory creation
      const content = await fs.readFile(cliConfigPath, { encoding: 'utf8' });
      const config = yaml.load(content) as CliConfig;
      const currentUserPath = config.directories?.user;
      if (currentUserPath === defaultArduinoPath) {
        await spawnCommand(cliPath, ['config', 'set', 'directories.user', blinkeyPath, '--config-file', cliConfigPath]);
        this.logger.info(`Set default sketchbook path to ${blinkeyPath} instead of ${defaultArduinoPath}`);
      }
    } catch (error) {
      this.logger.warn('Could not set default Blinkey sketchbook path:', error);
    }
    
    // Set data directory path to .Blinkey (where libraries are stored)
    try {
      // Read config file directly to avoid triggering CLI directory creation
      const content = await fs.readFile(cliConfigPath, { encoding: 'utf8' });
      const config = yaml.load(content) as CliConfig;
      const currentDataPath = config.directories?.data;
      if (currentDataPath) {
        const currentDataPathLower = currentDataPath.toLowerCase();
        if (currentDataPath === defaultArduino15Path || currentDataPathLower.includes('arduino15')) {
        // Replace Arduino15 with .Blinkey in the path
        let newDataPath = currentDataPath.replace(/Arduino15/gi, '.Blinkey').replace(/arduino15/gi, '.Blinkey');
        // Use platform-specific path if replacement didn't change anything
        if (newDataPath === currentDataPath) {
          newDataPath = blinkey15Path;
        }
        // Write directly to YAML file first to prevent directory creation
        const updatedConfig = {
          ...config,
          directories: {
            ...config.directories,
            data: newDataPath,
          },
        };
        await fs.writeFile(cliConfigPath, yaml.dump(updatedConfig), { encoding: 'utf8' });
        await spawnCommand(cliPath, ['config', 'set', 'directories.data', newDataPath, '--config-file', cliConfigPath]);
        this.logger.info(`Set default data directory to ${newDataPath} instead of ${currentDataPath}`);
        }
      }
    } catch (error) {
      this.logger.warn('Could not set default Blinkey data directory path:', error);
    }
  }

  private async mapCliConfigToAppConfig(
    cliConfig: DefaultCliConfig
  ): Promise<Config> {
    const { directories, locale = 'en' } = cliConfig;
    const { user, data } = directories;
    const additionalUrls: Array<string> = [];
    if (cliConfig.board_manager && cliConfig.board_manager.additional_urls) {
      additionalUrls.push(
        ...Array.from(new Set(cliConfig.board_manager.additional_urls))
      );
    }
    const network = Network.parse(cliConfig.network?.proxy);
    return {
      dataDirUri: FileUri.create(data).toString(),
      sketchDirUri: FileUri.create(user).toString(),
      additionalUrls,
      network,
      locale,
    };
  }

  private fireConfigChanged(
    oldState: ConfigState,
    newState: ConfigState
  ): void {
    this.configChangeEmitter.fire({ oldState, newState });
    this.notificationService.notifyConfigDidChange(newState);
  }

  private async validateCliConfig(config: DefaultCliConfig): Promise<void> {
    const errors: string[] = [];
    errors.push(...(await this.checkAccessible(config)));
    if (errors.length) {
      throw new InvalidConfigError(errors);
    }
  }

  private async checkAccessible({
    directories,
  }: DefaultCliConfig): Promise<string[]> {
    try {
      await fs.readdir(directories.user);
      return [];
    } catch (err) {
      console.error(
        `Check accessible failed for input: ${directories.user}`,
        err
      );
      return [
        nls.localize(
          'arduino/configuration/cli/inaccessibleDirectory',
          "Could not access the sketchbook location at '{0}': {1}",
          directories.user,
          String(err)
        ),
      ];
    }
  }

  private async updateDaemon(
    port: number,
    config: DefaultCliConfig
  ): Promise<void> {
    const json = JSON.stringify(config, null, 2);
    this.logger.info(`Updating daemon with 'data': ${json}`);

    const updatableConfig = {
      locale: config.locale,
      'directories.user': config.directories.user,
      'directories.data': config.directories.data,
      'network.proxy': config.network?.proxy,
      'board_manager.additional_urls':
        config.board_manager?.additional_urls || [],
    };

    const client = createArduinoCoreServiceClient({ port });

    for (const [key, value] of Object.entries(updatableConfig)) {
      const req = new SettingsSetValueRequest();
      req.setKey(key);
      req.setEncodedValue(JSON.stringify(value));
      await new Promise<void>((resolve) => {
        client.settingsSetValue(req, (error) => {
          if (error) {
            this.logger.error(
              `Could not update config with key: ${key} and value: ${value}`,
              error
            );
          }
          resolve();
        });
      });
    }

    client.close();
  }

  private async writeDaemonState(port: number): Promise<void> {
    const client = createArduinoCoreServiceClient({ port });
    const req = new ConfigurationSaveRequest();
    req.setSettingsFormat('yaml');

    const configRaw = await new Promise<string>((resolve, reject) => {
      client.configurationSave(req, (error, resp) => {
        try {
          if (error) {
            reject(error);
            return;
          }
          resolve(resp.getEncodedSettings());
        } finally {
          client.close();
        }
      });
    });

    // IMPORTANT: Parse YAML and normalize any Arduino15 paths with .Blinkey before writing
    // The daemon might return paths with .arduino15, so we need to normalize them
    try {
      const config = yaml.load(configRaw) as CliConfig;
      const homeDir = os.homedir();
      let normalizedData = config.directories?.data;
      let normalizedUser = config.directories?.user;
      let configChanged = false;
      
      if (config.directories?.data) {
        const dataPath = config.directories.data;
        const dataPathLower = dataPath.toLowerCase();
        if (dataPathLower.includes('arduino15')) {
          let defaultArduino15Path: string;
          let blinkey15Path: string;
          
          if (isWindows) {
            defaultArduino15Path = join(homeDir, 'AppData', 'Local', 'Arduino15');
            blinkey15Path = join(homeDir, 'AppData', 'Local', '.Blinkey');
          } else {
            defaultArduino15Path = join(homeDir, '.arduino15');
            blinkey15Path = join(homeDir, '.Blinkey');
          }
          
          if (dataPath === defaultArduino15Path) {
            normalizedData = blinkey15Path;
          } else {
            normalizedData = dataPath.replace(/Arduino15/gi, '.Blinkey').replace(/arduino15/gi, '.Blinkey');
          }
          configChanged = true;
          this.logger.info(`Normalized data directory from ${dataPath} to ${normalizedData}`);
        }
      }
      
      if (config.directories?.user) {
        const userPath = config.directories.user;
        let defaultArduinoPath: string;
        let blinkeyPath: string;
        
        if (isWindows) {
          defaultArduinoPath = join(homeDir, 'Documents', 'Arduino');
          blinkeyPath = join(homeDir, 'Documents', 'Blinkey');
        } else {
          defaultArduinoPath = join(homeDir, 'Arduino');
          blinkeyPath = join(homeDir, 'Blinkey');
        }
        
        if (userPath === defaultArduinoPath) {
          normalizedUser = blinkeyPath;
          configChanged = true;
          this.logger.info(`Normalized user directory from ${userPath} to ${blinkeyPath}`);
        }
      }
      
      // Create new config object with normalized paths if changes were made
      let finalConfig: CliConfig = config;
      if (configChanged && normalizedData && normalizedUser) {
        finalConfig = {
          ...config,
          directories: {
            ...config.directories,
            data: normalizedData,
            user: normalizedUser,
          },
        };
      }
      
      const cliConfigUri = await this.getCliConfigFileUri();
      const cliConfigPath = FileUri.fsPath(cliConfigUri);
      const finalYaml = configChanged ? yaml.dump(finalConfig) : configRaw;
      await fs.writeFile(cliConfigPath, finalYaml, { encoding: 'utf-8' });
      if (configChanged) {
        this.logger.info(`Wrote daemon state to ${cliConfigPath} (normalized Arduino15 paths to .Blinkey)`);
      } else {
        this.logger.info(`Wrote daemon state to ${cliConfigPath}`);
      }
    } catch (error) {
      // If YAML parsing fails, fall back to string replacement
      this.logger.warn('Failed to parse daemon config as YAML, using string replacement:', error);
      const homeDir = os.homedir();
      let normalizedConfig = configRaw;
      
      // Replace .arduino15 with .Blinkey (case-insensitive)
      normalizedConfig = normalizedConfig.replace(/\.arduino15/gi, '.Blinkey');
      normalizedConfig = normalizedConfig.replace(/arduino15/gi, '.Blinkey');
      
      // Also replace ~/Arduino with ~/Blinkey
      if (isWindows) {
        normalizedConfig = normalizedConfig.replace(
          new RegExp(join(homeDir, 'Documents', 'Arduino').replace(/\\/g, '\\\\'), 'gi'),
          join(homeDir, 'Documents', 'Blinkey')
        );
      } else {
        normalizedConfig = normalizedConfig.replace(
          new RegExp(join(homeDir, 'Arduino').replace(/\//g, '\\/'), 'g'),
          join(homeDir, 'Blinkey')
        );
      }

      const cliConfigUri = await this.getCliConfigFileUri();
      const cliConfigPath = FileUri.fsPath(cliConfigUri);
      await fs.writeFile(cliConfigPath, normalizedConfig, { encoding: 'utf-8' });
      this.logger.info(`Wrote daemon state to ${cliConfigPath} (normalized via string replacement)`);
    }
  }

  // #1445
  private async ensureUserDirExists(
    cliConfig: DefaultCliConfig
  ): Promise<void> {
    await fs.mkdir(cliConfig.directories.user, { recursive: true });
  }
}

class InvalidConfigError extends Error {
  constructor(readonly errors: string[]) {
    super('InvalidConfigError:\n - ' + errors.join('\n - '));
    if (!errors.length) {
      throw new Error("Illegal argument: 'messages'. It must not be empty.");
    }
    Object.setPrototypeOf(this, InvalidConfigError.prototype);
  }
}
