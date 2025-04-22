// Settings interface
export interface AureliaServerSettings {
  logging: {
    level: 'debug' | 'log' | 'info' | 'warn' | 'error' | 'none';
  };
  diagnostics: {
    enable: boolean;
  };
  completions: {
    standardHtml: {
      enable: boolean;
    };
  };
}

// Global settings variable with defaults
export let serverSettings: AureliaServerSettings = {
  logging: { level: 'debug' }, // Default level
  diagnostics: { enable: true },
  completions: { standardHtml: { enable: true } }
}; 