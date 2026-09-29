import { Logger, pageLog } from '../page_log';

pageLog.follow('worker');
new Logger('worker').info('logged before the port arrived');
