import { DataSource } from 'typeorm';
import { config } from 'dotenv';

config({
    path: ['.env', `.env.${process.env.NODE_ENV || 'production'}`],
});

export const AppDataSource = new DataSource({
    type: 'postgres',
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT, 10),
    username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    entities: [__dirname + '/../**/*.entity{.ts,.js}'],
    migrations: [__dirname + '/migrations/*.ts'],
    logging: true,
    synchronize: false, // Keep this false for migrations!
});