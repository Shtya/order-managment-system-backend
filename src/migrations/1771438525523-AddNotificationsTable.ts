import { MigrationInterface, QueryRunner } from "typeorm";

export class AddNotificationsTable1771438525523 implements MigrationInterface {
    name = 'AddNotificationsTable1771438525523'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "notifications" ("id" SERIAL NOT NULL, "user_id" integer NOT NULL, "type" character varying NOT NULL, "title" character varying NOT NULL, "message" text NOT NULL, "is_read" boolean NOT NULL DEFAULT false, "related_entity_type" character varying, "related_entity_id" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_6a72c3c0f683f6462415e653c3a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "plans" ADD "bulkUploadPerMonth" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "notifications" ADD CONSTRAINT "FK_9a8a82462cab47c73d25f49261f" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notifications" DROP CONSTRAINT "FK_9a8a82462cab47c73d25f49261f"`);
        await queryRunner.query(`ALTER TABLE "plans" DROP COLUMN "bulkUploadPerMonth"`);
        await queryRunner.query(`DROP TABLE "notifications"`);
    }

}
