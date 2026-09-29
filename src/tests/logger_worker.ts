import { Logger } from '../logger';

new Logger('worker-test', 'debug').info('logged from a worker');
postMessage('logged');
