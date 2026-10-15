import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTransactionCategoryAndWalletPaymentMethod1790000000000
  implements MigrationInterface
{
  name = "AddTransactionCategoryAndWalletPaymentMethod1790000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Dev databases may already have these from `synchronize`.
    await queryRunner.query(`
      UPDATE "transactions" AS t
      SET "category" = 'ai'
      FROM "billing_charges" AS bc
      WHERE bc."walletTransactionId" = t.id
        AND t."category" <> 'ai'
    `);

    await queryRunner.query(`
      UPDATE "transactions"
      SET "paymentMethod" = 'wallet'
      WHERE "paymentMethod" = 'other'
        AND "purpose" IN ('wallet_withdrawal', 'wallet_to_ai', 'ai_to_wallet')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_TRANSACTION_USER_CATEGORY_CREATED"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" DROP COLUMN IF EXISTS "category"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "transactions_category_enum"`);
  }
}
