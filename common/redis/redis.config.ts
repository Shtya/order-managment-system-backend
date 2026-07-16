import { registerAs } from '@nestjs/config';

const readBooleanEnv = (value?: string) => {
  if (!value) return false;
  return ['true', '1', 'yes', 'y', 'on'].includes(value.trim().toLowerCase());
};

export default registerAs('redis', () => {
  const port = Number(process.env.REDIS_PORT || 6379);
  const db = Number(process.env.REDIS_DB || 0);
  const password = (process.env.REDIS_PASSWORD || '').trim() || undefined;
  const username = (process.env.REDIS_USERNAME || '').trim() || undefined;
  const useTls = readBooleanEnv(process.env.REDIS_USE_TLS as string);

  return {
    host: (process.env.REDIS_HOST || '127.0.0.1').trim(),
    port,
    username,
    password,
    db,
    useTls,
    tls: useTls ? {} : undefined,
  };
});