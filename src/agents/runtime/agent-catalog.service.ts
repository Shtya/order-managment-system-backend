import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Brackets, Repository } from "typeorm";
import { CategoryEntity } from "entities/categories.entity";
import { BundleEntity } from "entities/bundle.entity";
import { ProductEntity, ProductImage, ProductVariantEntity } from "entities/sku.entity";
import { OrdersService } from "src/orders/services/orders.service";
import { expandBundleToOrderLineItems, imageSrc } from "common/healpers";

const MAX_SEARCH = 10;
const SEARCH_CANDIDATES = 80;
const DESC_CLIP = 240;
const AVAILABLE_CAP = 20;
const MAX_LINE_QTY = 50;
const MAX_CATALOG_IMAGES = 12;

const AR_FROM = "أإآةى";
const AR_TO = "اااهي";

export type AgentCatalogKind = "product" | "bundle" | "all";

export type AgentOrderLineInput = {
  variantId?: string;
  bundleId?: string;
  quantity: number;
};

export type AgentOrderDraftLine = {
  variantId: string;
  bundleId?: string;
  quantity: number;
  unitPrice: number;
  name: string;
  attributes: Record<string, string>;
};

export type AgentOrderDraft = {
  requested: AgentOrderLineInput[];
  lines: AgentOrderDraftLine[];
  productsTotal: number;
  priceFingerprint: string;
};

export class AgentCatalogError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "INVALID_ARGS" | "OUT_OF_STOCK" | "INACTIVE",
    message: string,
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AgentCatalogError";
  }
}

@Injectable()
export class AgentCatalogService {
  constructor(
    @InjectRepository(ProductEntity)
    private readonly productRepo: Repository<ProductEntity>,
    @InjectRepository(ProductVariantEntity)
    private readonly variantRepo: Repository<ProductVariantEntity>,
    @InjectRepository(BundleEntity)
    private readonly bundleRepo: Repository<BundleEntity>,
    @InjectRepository(CategoryEntity)
    private readonly categoryRepo: Repository<CategoryEntity>,
    @Inject(forwardRef(() => OrdersService))
    private readonly orders: OrdersService,
  ) {}

  async listCategories(adminId: string) {
    const rows = await this.categoryRepo
      .createQueryBuilder("c")
      .innerJoin(ProductEntity, "p", 'p."categoryId" = c.id AND p."adminId" = :adminId AND p."isActive" = true', {
        adminId,
      })
      .where("c.adminId = :adminId", { adminId })
      .select("c.id", "id")
      .addSelect("c.name", "name")
      .addSelect("COUNT(p.id)", "productCount")
      .groupBy("c.id")
      .addGroupBy("c.name")
      .orderBy("c.name", "ASC")
      .getRawMany();
    return rows.map((r) => ({ id: r.id, name: r.name, productCount: Number(r.productCount ?? 0) }));
  }

  async search(
    adminId: string,
    args: {
      query?: string;
      categoryId?: string;
      minPrice?: number;
      maxPrice?: number;
      options?: Record<string, string>;
      inStockOnly?: boolean;
      kind?: AgentCatalogKind;
      limit?: number;
      page?: number;
    },
  ) {
    const limit = Math.min(MAX_SEARCH, Math.max(1, Number(args.limit) || 8));
    const page = Math.max(1, Number(args.page) || 1);
    const inStockOnly = args.inStockOnly !== false;
    const kind = args.kind ?? "all";
    const reservedEnabled = await this.reservedEnabled(adminId);
    const words = splitWords(args.query);
    const optionEntries = Object.entries(args.options ?? {}).filter(([, v]) => String(v ?? "").trim());

    const [products, bundles] = await Promise.all([
      kind === "bundle" ? [] : this.searchProducts(adminId, { ...args, words, reservedEnabled, inStockOnly }),
      kind === "product" ? [] : this.searchBundles(adminId, { ...args, words, reservedEnabled, inStockOnly }),
    ]);

    const filteredProducts = optionEntries.length
      ? products.filter((p) =>
          p.variants.some((v) => optionEntries.every(([k, val]) => variantMatchesOption(v.attributes, k, val))),
        )
      : products;

    const items = [
      ...filteredProducts.map((p) => this.toProductHit(p, reservedEnabled)),
      ...bundles.map((b) => this.toBundleHit(b, reservedEnabled)),
    ].sort((a, b) => {
      if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
      return b.createdAt.localeCompare(a.createdAt);
    });

    const total = items.length;
    const pageItems = items.slice((page - 1) * limit, page * limit).map(({ createdAt: _c, ...rest }) => rest);
    return { total, page, hasMore: page * limit < total, items: pageItems };
  }

  async getProductDetails(adminId: string, productId: string) {
    if (!isUuid(productId)) throw new AgentCatalogError("INVALID_ARGS", "productId must come from search_products");
    const product = await this.productRepo.findOne({
      where: { id: productId, adminId, isActive: true },
      relations: { category: true, variants: true },
    });
    if (!product) throw new AgentCatalogError("NOT_FOUND", "No active product with this id");
    const variants = (product.variants ?? []).filter((v) => v.isActive);
    const options = collectOptions(variants.map((v) => v.attributes));
    const listed = await Promise.all(
      variants.map(async (v) => {
        const available = await this.availableOf(adminId, v);
        return {
          variantId: v.id,
          attributes: v.attributes ?? {},
          price: unitPrice(v, product),
          available: Math.min(AVAILABLE_CAP, available),
          inStock: available > 0,
        };
      }),
    );
    const prices = listed.map((v) => v.price);
    const upsells =
      product.upsellingEnabled && Array.isArray(product.upsellingProducts)
        ? product.upsellingProducts
            .filter((u) => u?.productId)
            .slice(0, 5)
            .map((u) => ({ productId: u.productId, label: u.label || u.callCenterDescription || null }))
        : [];
    return {
      productId: product.id,
      name: product.name,
      category: product.category?.name ?? null,
      description: clip(product.description, DESC_CLIP),
      callCenterDescription: clip(product.callCenterProductDescription, DESC_CLIP),
      images: catalogImageUrls(product.mainImage, product.images),
      priceMin: prices.length ? Math.min(...prices) : Number(product.salePrice ?? 0),
      priceMax: prices.length ? Math.max(...prices) : Number(product.salePrice ?? 0),
      options,
      variants: listed,
      upsells,
    };
  }

  async getBundleDetails(adminId: string, bundleId: string) {
    if (!isUuid(bundleId)) throw new AgentCatalogError("INVALID_ARGS", "bundleId must come from search_products");
    const bundle = await this.loadBundle(adminId, bundleId);
    if (!bundle) throw new AgentCatalogError("NOT_FOUND", "No active bundle with this id");
    const items = await Promise.all(
      (bundle.items ?? []).map(async (bi) => {
        const variant = bi.variant;
        const available = variant ? await this.availableOf(adminId, variant) : 0;
        return {
          product: variant?.product?.name ?? null,
          attributes: variant?.attributes ?? {},
          qtyPerBundle: bi.qty,
          available,
        };
      }),
    );
    const wholeBundles = items.length
      ? Math.min(...items.map((i) => (i.qtyPerBundle > 0 ? Math.floor(i.available / i.qtyPerBundle) : 0)))
      : 0;
    return {
      bundleId: bundle.id,
      name: bundle.name,
      price: Number(bundle.price ?? 0),
      description: clip(bundle.description, DESC_CLIP),
      images: catalogImageUrls(bundle.mainImage, bundle.images),
      items: items.map(({ available: _a, ...rest }) => rest),
      available: Math.min(AVAILABLE_CAP, Math.max(0, wholeBundles)),
      inStock: wholeBundles > 0,
    };
  }

  /**
   * Prices and expands items, then checks summed stock. Throws AgentCatalogError on failure.
   * `strictPrices` is used on confirm: if a priced line no longer matches, throw 409-style INACTIVE/price change.
   */
  async buildOrderDraft(
    adminId: string,
    requested: AgentOrderLineInput[],
    previousFingerprint?: string,
  ): Promise<AgentOrderDraft> {
    if (!requested.length) throw new AgentCatalogError("INVALID_ARGS", "items are required");
    const lines: AgentOrderDraftLine[] = [];

    for (const item of requested) {
      const quantity = Math.floor(Number(item.quantity));
      if (!Number.isFinite(quantity) || quantity < 1) {
        throw new AgentCatalogError("INVALID_ARGS", "Each item quantity must be at least 1");
      }
      if (quantity > MAX_LINE_QTY) {
        throw new AgentCatalogError("INVALID_ARGS", `Quantity per line is at most ${MAX_LINE_QTY}`);
      }
      const variantId = str(item.variantId);
      const bundleId = str(item.bundleId);
      if (Boolean(variantId) === Boolean(bundleId)) {
        throw new AgentCatalogError("INVALID_ARGS", "Each item must have either variantId or bundleId");
      }

      if (bundleId) {
        const bundle = await this.loadBundle(adminId, bundleId);
        if (!bundle) throw new AgentCatalogError("NOT_FOUND", "Unknown or inactive bundle");
        const expanded = expandBundleToOrderLineItems(bundle as any, quantity);
        for (const line of expanded) {
          const variant = (bundle.items ?? []).find((i) => i.variantId === line.variantId)?.variant;
          lines.push({
            variantId: line.variantId,
            bundleId: bundle.id,
            quantity: line.quantity,
            unitPrice: Number(line.unitPrice ?? 0),
            name: `${bundle.name}${variant?.product?.name ? ` — ${variant.product.name}` : ""}`,
            attributes: variant?.attributes ?? {},
          });
        }
      } else {
        const variant = await this.variantRepo.findOne({
          where: { id: variantId, adminId, isActive: true },
          relations: { product: true },
        });
        if (!variant?.product?.isActive) {
          throw new AgentCatalogError("NOT_FOUND", "Unknown or inactive product variant");
        }
        lines.push({
          variantId: variant.id,
          quantity,
          unitPrice: unitPrice(variant, variant.product),
          name: variant.product.name,
          attributes: variant.attributes ?? {},
        });
      }
    }

    const needed = new Map<string, { qty: number; sample: AgentOrderDraftLine }>();
    for (const line of lines) {
      const cur = needed.get(line.variantId) ?? { qty: 0, sample: line };
      cur.qty += line.quantity;
      needed.set(line.variantId, cur);
    }
    for (const [variantId, { qty, sample }] of needed) {
      const variant = await this.variantRepo.findOne({ where: { id: variantId, adminId } });
      if (!variant?.isActive) {
        throw new AgentCatalogError("INACTIVE", `${sample.name} is no longer available`);
      }
      const available = await this.availableOf(adminId, variant);
      if (available < qty) {
        throw new AgentCatalogError("OUT_OF_STOCK", `${sample.name}: only ${available} available`, {
          name: sample.name,
          available,
          requested: qty,
        });
      }
    }

    const productsTotal = round2(lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0));
    const priceFingerprint = fingerprint(lines);
    if (previousFingerprint && previousFingerprint !== priceFingerprint) {
      throw new AgentCatalogError("INACTIVE", "Prices or items changed. Collect the order again.");
    }
    return {
      requested: requested.map((r) => ({
        variantId: str(r.variantId) || undefined,
        bundleId: str(r.bundleId) || undefined,
        quantity: Math.floor(Number(r.quantity)),
      })),
      lines,
      productsTotal,
      priceFingerprint,
    };
  }

  private async searchProducts(
    adminId: string,
    args: {
      categoryId?: string;
      minPrice?: number;
      maxPrice?: number;
      words: string[];
      reservedEnabled: boolean;
      inStockOnly: boolean;
    },
  ) {
    const qb = this.productRepo
      .createQueryBuilder("p")
      .leftJoinAndSelect("p.category", "category")
      .leftJoinAndSelect("p.variants", "v", 'v."isActive" = true')
      .where('p."adminId" = :adminId', { adminId })
      .andWhere('p."isActive" = true')
      .orderBy("p.created_at", "DESC")
      .take(SEARCH_CANDIDATES);

    if (args.categoryId) {
      if (!isUuid(args.categoryId)) return [];
      qb.andWhere('p."categoryId" = :categoryId', { categoryId: args.categoryId });
    }
    for (const [i, word] of args.words.entries()) {
      const param = `pw${i}`;
      qb.andWhere(
        new Brackets((b) => {
          b.where(`${arSql("p.name")} LIKE :${param}`)
            .orWhere(`${arSql("p.sku")} LIKE :${param}`)
            .orWhere(`${arSql("COALESCE(p.description, '')")} LIKE :${param}`)
            .orWhere(`${arSql('COALESCE(p."callCenterProductDescription", \'\')')} LIKE :${param}`)
            .orWhere(`${arSql("COALESCE(category.name, '')")} LIKE :${param}`)
            .orWhere(
              `EXISTS (SELECT 1 FROM product_variants vx WHERE vx."productId" = p.id AND vx."isActive" = true AND ${arSql("COALESCE(vx.sku, '')")} LIKE :${param})`,
            );
        }),
        { [param]: `%${word}%` },
      );
    }
    if (args.minPrice != null || args.maxPrice != null) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM product_variants vp WHERE vp."productId" = p.id AND vp."isActive" = true AND COALESCE(vp.price, p."salePrice", 0) BETWEEN :minPrice AND :maxPrice)`,
        { minPrice: args.minPrice ?? 0, maxPrice: args.maxPrice ?? 1e12 },
      );
    }
    if (args.inStockOnly) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM product_variants vs WHERE vs."productId" = p.id AND vs."isActive" = true AND ${stockSql("vs", args.reservedEnabled)} > 0)`,
      );
    }
    return qb.getMany();
  }

  private async searchBundles(
    adminId: string,
    args: {
      minPrice?: number;
      maxPrice?: number;
      words: string[];
      reservedEnabled: boolean;
      inStockOnly: boolean;
    },
  ) {
    const qb = this.bundleRepo
      .createQueryBuilder("b")
      .leftJoinAndSelect("b.items", "bi", 'bi."isActive" = true')
      .leftJoinAndSelect("bi.variant", "v")
      .leftJoinAndSelect("v.product", "p")
      .where('b."adminId" = :adminId', { adminId })
      .andWhere('b."isActive" = true')
      .orderBy("b.created_at", "DESC")
      .take(SEARCH_CANDIDATES);

    for (const [i, word] of args.words.entries()) {
      const param = `bw${i}`;
      qb.andWhere(
        new Brackets((b) => {
          b.where(`${arSql("b.name")} LIKE :${param}`).orWhere(`${arSql("b.sku")} LIKE :${param}`);
        }),
        { [param]: `%${word}%` },
      );
    }
    if (args.minPrice != null) qb.andWhere("b.price >= :bmin", { bmin: args.minPrice });
    if (args.maxPrice != null) qb.andWhere("b.price <= :bmax", { bmax: args.maxPrice });

    const bundles = await qb.getMany();
    if (!args.inStockOnly) return bundles;
    const out: BundleEntity[] = [];
    for (const bundle of bundles) {
      if ((await this.wholeBundlesAvailable(adminId, bundle)) > 0) out.push(bundle);
    }
    return out;
  }

  private toProductHit(product: ProductEntity, reservedEnabled: boolean) {
    const variants = (product.variants ?? []).filter((v) => v.isActive);
    const prices = variants.map((v) => unitPrice(v, product));
    const inStock = variants.some((v) => availableFromCounts(v, reservedEnabled) > 0);
    return {
      kind: "product" as const,
      productId: product.id,
      name: product.name,
      category: product.category?.name ?? null,
      priceMin: prices.length ? Math.min(...prices) : Number(product.salePrice ?? 0),
      priceMax: prices.length ? Math.max(...prices) : Number(product.salePrice ?? 0),
      inStock,
      options: collectOptions(variants.map((v) => v.attributes)),
      description: clip(product.callCenterProductDescription || product.description, DESC_CLIP),
      createdAt: (product.created_at as Date)?.toISOString?.() ?? "",
    };
  }

  private toBundleHit(bundle: BundleEntity, reservedEnabled: boolean) {
    const names = (bundle.items ?? [])
      .map((i) => i.variant?.product?.name)
      .filter(Boolean)
      .slice(0, 8);
    const inStock = (bundle.items ?? []).every((i) => {
      const need = i.qty || 1;
      return i.variant && availableFromCounts(i.variant, reservedEnabled) >= need;
    });
    return {
      kind: "bundle" as const,
      bundleId: bundle.id,
      name: bundle.name,
      price: Number(bundle.price ?? 0),
      inStock,
      items: names,
      createdAt: (bundle.created_at as Date)?.toISOString?.() ?? "",
    };
  }

  private async loadBundle(adminId: string, bundleId: string) {
    return this.bundleRepo.findOne({
      where: { id: bundleId, adminId, isActive: true },
      relations: { items: { variant: { product: true } } },
    });
  }

  private async wholeBundlesAvailable(adminId: string, bundle: BundleEntity) {
    const items = bundle.items ?? [];
    if (!items.length) return 0;
    let min = Infinity;
    for (const bi of items) {
      if (!bi.variant?.isActive || !bi.variant.product?.isActive) return 0;
      const available = await this.availableOf(adminId, bi.variant);
      const per = bi.qty || 1;
      min = Math.min(min, Math.floor(available / per));
    }
    return Number.isFinite(min) ? Math.max(0, min) : 0;
  }

  private async availableOf(adminId: string, variant: ProductVariantEntity) {
    return this.orders.calculateAvailableStock(variant.stockOnHand || 0, variant.reserved || 0, adminId);
  }

  private async reservedEnabled(adminId: string) {
    const withReserved = await this.orders.calculateAvailableStock(10, 3, adminId);
    return withReserved === 7;
  }
}

function arSql(expr: string) {
  return `translate(lower(${expr}), '${AR_FROM}', '${AR_TO}')`;
}

function stockSql(alias: string, reservedEnabled: boolean) {
  return reservedEnabled
    ? `GREATEST(0, COALESCE(${alias}."stockOnHand", 0) - COALESCE(${alias}.reserved, 0))`
    : `GREATEST(0, COALESCE(${alias}."stockOnHand", 0))`;
}

function splitWords(query?: string) {
  return normalizeAr(query ?? "")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 1)
    .slice(0, 8);
}

function normalizeAr(value: string) {
  return String(value)
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .trim();
}

function variantMatchesOption(attributes: Record<string, string> | null | undefined, key: string, value: string) {
  const wantKey = normalizeAr(key);
  const wantVal = normalizeAr(value);
  return Object.entries(attributes ?? {}).some(
    ([k, v]) => normalizeAr(k) === wantKey && normalizeAr(String(v)) === wantVal,
  );
}

function catalogImageUrls(mainImage?: string | null, images?: Array<ProductImage | string> | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown) => {
    const abs = imageSrc(String(value ?? "").trim());
    if (!abs || seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  };
  push(mainImage);
  for (const item of images ?? []) {
    push(typeof item === "string" ? item : item?.url);
  }
  return out.slice(0, MAX_CATALOG_IMAGES);
}

function collectOptions(attrsList: Array<Record<string, string> | null | undefined>) {
  const map = new Map<string, Set<string>>();
  for (const attrs of attrsList) {
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (!k || v == null || String(v).trim() === "") continue;
      if (!map.has(k)) map.set(k, new Set());
      map.get(k)!.add(String(v));
    }
  }
  return Object.fromEntries([...map.entries()].map(([k, set]) => [k, [...set]]));
}

function unitPrice(variant: ProductVariantEntity, product?: ProductEntity | null) {
  const fromVariant = Number(variant.price ?? 0);
  if (fromVariant > 0) return fromVariant;
  return Number(product?.salePrice ?? 0);
}

function availableFromCounts(variant: ProductVariantEntity, reservedEnabled: boolean) {
  const onHand = variant.stockOnHand || 0;
  const reserved = variant.reserved || 0;
  return Math.max(0, reservedEnabled ? onHand - reserved : onHand);
}

function clip(text: string | null | undefined, max: number) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function isUuid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

function str(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function fingerprint(lines: AgentOrderDraftLine[]) {
  return lines
    .map((l) => `${l.variantId}:${l.bundleId ?? ""}:${l.quantity}:${l.unitPrice}`)
    .sort()
    .join("|");
}
