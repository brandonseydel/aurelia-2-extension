import { Connection } from 'vscode-languageserver/node';
import { AureliaServerSettings, serverSettings } from '../common/settings';

// Store connection and settings internally after initialization
let _connection: Connection | undefined = undefined;
let _settings: AureliaServerSettings = serverSettings; // Initialize with default settings

const LOG_LEVEL_ORDER: { [key in AureliaServerSettings['logging']['level']]: number } = {
  'debug': 1,
  'log': 2,
  'info': 3,
  'warn': 4,
  'error': 5,
  'none': 6
};

/**
 * Initializes the logger with the VS Code connection and server settings.
 * Must be called before the first call to log().
 */
export function initializeLogger(connection: Connection, settings: AureliaServerSettings): void {
    _connection = connection;
    _settings = settings; 
    _connection.console.log("[Logger] Logger initialized."); 
}

/**
 * Logs a message to the VS Code console if the level is sufficient.
 */
export function log(level: 'error' | 'warn' | 'info' | 'log' | 'debug', message: string, ...optionalParams: any[]): void {
  if (!_connection) {
    console.error("Logger not initialized. Call initializeLogger first.");
    // Optionally buffer messages here if needed before connection is ready
    return;
  }

  const currentLevel = _settings.logging.level;
  if (currentLevel === 'none' || LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[currentLevel]) {
      return; // Skip logging if level is none or message level is lower than current setting
  }

  let logMessage = `[${level.toUpperCase()}] ${message}`;
  if (optionalParams.length > 0) {
    try {
      const paramsString = optionalParams.map(p => 
        typeof p === 'object' ? JSON.stringify(p, null, 2) : String(p) // Pretty print objects
      ).join(' \n'); 
      logMessage += `\n--- PARAMS ---\n${paramsString}\n--------------`;
    } catch (e) {
      _connection.console.error("[Logger] Error processing optional params during logging.");
    }
  }

  switch (level) {
    case 'error': _connection.console.error(logMessage); break;
    case 'warn': _connection.console.warn(logMessage); break;
    case 'info': _connection.console.info(logMessage); break;
    case 'log': case 'debug': _connection.console.log(logMessage); break;
  }
} 