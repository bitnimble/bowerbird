import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { Logger, logOutput } from './logger';
import { serverLogPath } from './utils/paths';

const log = new Logger('server');

const logPath = serverLogPath(config.dbPath);
mkdirSync(path.dirname(logPath), { recursive: true });
logOutput.toFile(logPath);

process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { err });
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log.error('unhandled rejection', { err });
  process.exit(1);
});
