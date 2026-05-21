import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    Index,
} from 'typeorm';

@Entity('system_errors')
export class SystemErrorEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'varchar', nullable: true })
    userId: string | null;

    @Index()
    @Column({ type: 'varchar', nullable: true })
    adminId: string | null;

    @Column({ type: 'varchar', nullable: true })
    endpoint: string | null;

    @Column({ type: 'varchar', nullable: true })
    method: string | null;

    @Column({ type: 'jsonb', nullable: true })
    requestPayload: Record<string, any> | null;

    @Column({ type: 'jsonb', nullable: true })
    headers: Record<string, any> | null;

    @Column({ type: 'jsonb', nullable: true })
    pathParams: Record<string, any> | null;

    @Column({ type: 'jsonb', nullable: true })
    searchParams: Record<string, any> | null;

    @Column({ type: 'varchar' })
    errorMessage: string;

    @Column({ type: 'text', nullable: true })
    stackTrace: string | null;

    @Column({ type: 'jsonb', nullable: true })
    additionalDetails: Record<string, any> | null; // Catch-all for "every other detail" (e.g., DB state, 3rd party API responses)

    @Column({ type: 'varchar', nullable: true })
    ipAddress: string | null;

    @Column({ type: 'varchar', nullable: true })
    userAgent: string | null;

    @Column({ type: 'varchar', nullable: true })
    contentType: string | null;

    @Column({ type: 'varchar', nullable: true })
    environment: string | null;

    @Column({ type: 'int', nullable: true })
    httpStatus: number | null;

    @Column({ type: 'varchar', nullable: true })
    controllerName: string | null;

    @Column({ type: 'varchar', nullable: true })
    handlerName: string | null;

    @Column({ type: 'varchar', nullable: true })
    exceptionName: string | null;

    @Column({ type: 'jsonb', nullable: true })
    validationErrors: Record<string, any> | null;

    @Column({ type: 'jsonb', nullable: true })
    externalContext: Record<string, any> | null; // upstream requests/responses

    @Column({ type: 'int', nullable: true })
    durationMs: number | null;

    @Column({ type: 'varchar', nullable: true })
    routePattern: string | null;

    @Column({ type: 'varchar', nullable: true })
    errorCode: string | null;

    @Column({ type: 'jsonb', nullable: true })
    dbContext: Record<string, any> | null;

    @Column({ type: 'varchar', nullable: true })
    referer: string | null;

    @Column({ type: 'varchar', nullable: true })
    frontendRoute: string | null;

    @Column({ type: 'jsonb', nullable: true })
    responseData: Record<string, any> | null;

    @Column({ type: 'varchar', nullable: true })
    severity: 'fatal' | 'error' | 'warn' | null;

    @Column({ type: 'int', nullable: true })
    responseSize: number | null;

    @Column({ type: 'int', nullable: true })
    requestSize: number | null;

    @Column({ type: 'varchar', nullable: true })
    routePath: string | null;

    @Column({ type: 'varchar', nullable: true })
    originalUrl: string | null;

    @CreateDateColumn({ type: "timestamptz" })
    createdAt: Date; // The exact time of the exception

}

