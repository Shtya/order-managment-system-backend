import { registerAs } from "@nestjs/config";

export default registerAs('redis', () => ({
  host: process.env.REDIS_HOST as string,
  port: parseInt(process.env.REDIS_PORT as string, 10),
  password: process.env.REDIS_PASSWORD as string,
  db: parseInt(process.env.REDIS_DB || '0', 10),
}));