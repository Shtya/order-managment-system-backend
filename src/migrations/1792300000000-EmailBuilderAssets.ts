import { MigrationInterface, QueryRunner } from "typeorm";
export class EmailBuilderAssets1792300000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE email_assets (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "adminId" uuid NOT NULL,
      format varchar NOT NULL, "sourceWidth" integer NOT NULL, "sourceHeight" integer NOT NULL,
      variants jsonb NOT NULL, "leaseUntil" timestamptz NOT NULL,
      saved boolean NOT NULL DEFAULT false, queued boolean NOT NULL DEFAULT false,
      permanent boolean NOT NULL DEFAULT false, "createdAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query('CREATE INDEX ON email_assets ("adminId")');
  }
  async down(q: QueryRunner) {
    await q.query("DROP TABLE email_assets");
  }
}
