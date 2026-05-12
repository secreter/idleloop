import pino from 'pino';

/**
 * pino logger 包装。开发时走 pretty，生产走 JSON。
 *
 * 用 IDLELOOP_LOG_LEVEL 环境变量覆盖级别（debug/info/warn/error），
 * 默认 info。子模块用 logger.child({ mod: 'watcher' }) 派生命名 logger。
 */

// 默认 warn —— 命令行工具用户不需要看到 info 级别的内部状态。
// 调试用 IDLELOOP_LOG_LEVEL=info 或 =debug 显式打开。
const level = process.env['IDLELOOP_LOG_LEVEL'] ?? 'warn';
const isDev = process.env['NODE_ENV'] !== 'production';
const isTTY = process.stderr.isTTY;

export const logger = pino(
  {
    level,
    base: { app: 'idleloop' },
    ...(isDev && isTTY
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss',
              ignore: 'pid,hostname,app',
              destination: 2,
            },
          },
        }
      : {}),
  },
  // 走 stderr 而不是 stdout，避免污染 --json 等结构化输出
  isDev && isTTY ? undefined : pino.destination({ dest: 2, sync: true }),
);

export type Logger = typeof logger;
