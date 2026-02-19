import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
// This is the magic line that fixes the "Cannot find module" errors
import 'tsconfig-paths/register';

config();

export default new DataSource({
    type: 'postgres',
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    // Note: __dirname is root, so we look into src
    entities: [__dirname + '/src/**/*.entity{.ts,.js}'],
    migrations: [__dirname + '/src/migrations/*{.ts,.js}'],
    synchronize: false,
    logging: true,
});