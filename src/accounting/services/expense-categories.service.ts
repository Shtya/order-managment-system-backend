import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { TranslationService } from "common/translation.service";
import {
  CreateManualExpenseCategoryDto,
  UpdateManualExpenseCategoryDto,
} from "dto/accounting.dto";
import {
  ManualExpenseCategoryEntity,
  ManualExpenseEntity,
} from "entities/accounting.entity";
import { tenantId } from "src/category/category.service";
import { Not, Repository } from "typeorm";

@Injectable()
export class ExpenseCategoriesService {
  constructor(
    @InjectRepository(ManualExpenseCategoryEntity)
    private categoryRepo: Repository<ManualExpenseCategoryEntity>,
    private readonly translations: TranslationService,
  ) {}

  async createCategory(me: any, dto: CreateManualExpenseCategoryDto) {
    const adminId = tenantId(me);
    const existing = await this.categoryRepo.findOne({
      where: { adminId, name: dto.name },
    });
    if (existing) {
      this.translations.t("domains.expenses.category_name_exists");
    }
    const category = this.categoryRepo.create({ ...dto, adminId });
    return await this.categoryRepo.save(category);
  }

  async listCategories(me: any, query?: any) {
    const adminId = tenantId(me);
    const isActiveFilter = query?.isActive;

    const qb = this.categoryRepo
      .createQueryBuilder("category")
      .where("category.adminId = :adminId", { adminId });

    if (isActiveFilter !== undefined) {
      // Handle strings like "true"/"false" if they come from a URL query
      const isActive = isActiveFilter === "true" || isActiveFilter === true;
      qb.andWhere("category.isActive = :isActive", { isActive });
    }

    qb.addSelect((subQuery) => {
      return subQuery
        .select("COUNT(expense.id)")
        .from(ManualExpenseEntity, "expense")
        .where("expense.categoryId = category.id");
    }, "category_expensesCount");

    qb.addSelect(
      `COALESCE((SELECT SUM(e.amount) FROM manual_expenses e WHERE e."categoryId" = category.id), 0)`,
      "category_totalCost",
    );

    qb.orderBy("category.name", "ASC");

    const { entities, raw } = await qb.getRawAndEntities();
    const rawById = new Map(
      raw.map((row) => [String(row.category_id ?? ""), row]),
    );

    return entities.map((cat) => {
      const row = rawById.get(cat.id);
      return {
        ...cat,
        expensesCount: Number(row?.category_expensesCount ?? 0),
        totalCost: Number(row?.category_totalCost ?? 0),
      };
    });
  }

  async updateCategory(
    me: any,
    id: string,
    dto: UpdateManualExpenseCategoryDto,
  ) {
    const adminId = tenantId(me);

    const category = await this.categoryRepo.findOne({
      where: { id, adminId },
    });
    if (!category) {
      throw new NotFoundException(
        this.translations.t("domains.expenses.category_not_found"),
      );
    }

    if (dto.name && dto.name !== category.name) {
      const nameExists = await this.categoryRepo.findOne({
        where: { adminId, name: dto.name, id: Not(id) },
      });
      if (nameExists) {
        throw new BadRequestException(
          this.translations.t("domains.expenses.category_name_exists"),
        );
      }
    }

    Object.assign(category, dto);
    return await this.categoryRepo.save(category);
  }

  async deleteCategory(me: any, id: string) {
    const adminId = tenantId(me);

    const category = await this.categoryRepo.findOne({
      where: { id, adminId },
    });

    if (!category) {
      throw new NotFoundException(
        this.translations.t("domains.expenses.category_not_found"),
      );
    }

    await this.categoryRepo.remove(category);
    return {
      success: true,
      message: this.translations.t(
        "domains.expenses.category_deleted_successfully",
      ),
    };
  }
}
