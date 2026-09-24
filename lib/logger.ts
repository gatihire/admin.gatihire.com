/**
 * Logger utility for Truckinzy platform
 * Controls console logging based on environment
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LoggerOptions {
  enabled: boolean;
  level: LogLevel;
}

// Default configuration - logs enabled at info level for observability in all
// environments (webhook reply debugging needs visibility in production).
const defaultOptions: LoggerOptions = {
  enabled: true,
  level: process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info'
};

// Logger instance with configuration
class Logger {
  private options: LoggerOptions;

  constructor(options: Partial<LoggerOptions> = {}) {
    this.options = { ...defaultOptions, ...options };
  }

  // Check if logging is enabled for the given level
  private isEnabled(level: LogLevel): boolean {
    if (!this.options.enabled) return false;
    
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const configLevelIndex = levels.indexOf(this.options.level);
    const currentLevelIndex = levels.indexOf(level);
    
    return currentLevelIndex >= configLevelIndex;
  }

  debug(...args: any[]): void {
    if (this.isEnabled('debug')) {
      console.debug(...args);
    }
  }

  info(...args: any[]): void {
    if (this.isEnabled('info')) {
      console.info(...args);
    }
  }

  warn(...args: any[]): void {
    if (this.isEnabled('warn')) {
      console.warn(...args);
    }
  }

  error(...args: any[]): void {
    if (this.isEnabled('error')) {
      console.error(...args);
    }
  }

  // Special method for development-only logs
  dev(...args: any[]): void {
    if (process.env.NODE_ENV === 'development' && this.options.enabled) {
      console.log(...args);
    }
  }
}

// Create and export default logger instance
export const logger = new Logger();

// Export factory function for creating custom loggers
export function createLogger(options: Partial<LoggerOptions> = {}): Logger {
  return new Logger(options);
}