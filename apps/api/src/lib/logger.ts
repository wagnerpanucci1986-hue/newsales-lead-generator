import { pino } from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  // nunca registrar segredos mesmo que alguém logue o objeto inteiro
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.passwordHash', '*.token'],
  transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
});
