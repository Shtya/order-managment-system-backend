import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { Repository, Brackets, SelectQueryBuilder } from 'typeorm';
import { BadRequestException } from '@nestjs/common';

export interface CustomPaginatedResponse<T> {
	total_records: number;
	current_page: number;
	per_page: number;
	records: T[];
}

type Filters = Record<string, any>;
type Paginated<T> = {
	total_records: number;
	current_page: number;
	per_page: number;
	records: T[];
};

export class CRUD {
	static async findAll<T>(
		repository: Repository<T>,
		entityName: string,
		search?: string,
		page: any = 1,
		limit: any = 10,
		sortBy?: string,
		sortOrder: "ASC" | "DESC" = "DESC",
		relations: string[] = [],
		searchFields: string[] = [],
		filters?: Filters
	): Promise<Paginated<T>> {
		const pageNumber = Number(page) || 1;
		const limitNumber = Number(limit) || 10;

		if (isNaN(pageNumber) || isNaN(limitNumber) || pageNumber < 1 || limitNumber < 1) {
			throw new BadRequestException("Pagination parameters must be valid numbers greater than 0.");
		}
		if (!["ASC", "DESC"].includes(sortOrder)) {
			throw new BadRequestException("Sort order must be either 'ASC' or 'DESC'.");
		}

		const skip = (pageNumber - 1) * limitNumber;

		// ✅ Use ONE query builder only
		const qb = repository.createQueryBuilder(entityName).skip(skip).take(limitNumber);
		const meta = repository.metadata;

		const colByProp = new Map(meta.columns.map((c) => [c.propertyName, c]));
		const colByDb = new Map(meta.columns.map((c) => [c.databaseName, c]));

		// Track joined aliases (underscore aliases)
		const joined = new Set<string>();

		function isRelationPath(path: string): boolean {
			const parts = path.split(".");
			let currentMeta: any = meta;
			for (const part of parts) {
				const rel = currentMeta.relations.find((r: any) => r.propertyName === part || r.relationPath === part);
				if (!rel) return false;
				currentMeta = rel.inverseEntityMetadata;
			}
			return true;
		}

		// ✅ FIX: safe aliasing (no dots), join on qb
		function ensureJoin(path: string) {
			if (!path || !isRelationPath(path)) return;

			const parts = path.split(".");
			let currentAlias = entityName;
			let currentMeta: any = meta;

			// aliasPath will be underscore-based: items_variant
			let aliasPath = "";

			for (const part of parts) {
				const rel = currentMeta.relations.find((r: any) => r.propertyName === part || r.relationPath === part);
				if (!rel) break;

				const joinPath = `${currentAlias}.${part}`;
				aliasPath = aliasPath ? `${aliasPath}_${part}` : part; // ✅ underscore alias

				if (!joined.has(aliasPath)) {
					qb.leftJoin(joinPath, aliasPath);
					joined.add(aliasPath);
				}

				currentAlias = aliasPath;
				currentMeta = rel.inverseEntityMetadata;
			}
		}

		function resolveOwnColumnName(field: string): string | null {
			const col =
				colByProp.get(field) ||
				colByDb.get(field) ||
				(field === "created_at" ? colByProp.get("createdAt") : null) ||
				(field === "createdAt" ? colByDb.get("created_at") : null);

			return col ? col.databaseName : null;
		}

		function qualifyField(fieldPath: string): string {
			// local column
			if (!fieldPath.includes(".")) {
				const dbName = resolveOwnColumnName(fieldPath) || fieldPath;
				return `${entityName}.${dbName}`;
			}

			// relation column
			const parts = fieldPath.split(".");
			const relationPath = parts.slice(0, -1).join(".");
			const last = parts[parts.length - 1];

			ensureJoin(relationPath);

			const alias = isRelationPath(relationPath) ? relationPath.split(".").join("_") : entityName;
			return `${alias}.${last}`;
		}

		function flatten(obj: any, prefix = ""): Record<string, any> {
			const out: Record<string, any> = {};
			if (!obj || typeof obj !== "object") return out;

			for (const [k, v] of Object.entries(obj)) {
				const key = prefix ? `${prefix}.${k}` : k;
				if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flatten(v, key));
				else out[key] = v;
			}
			return out;
		}

		// ---- Tenant scope for adminId ----
		const tenant = (filters as any)?.__tenant;
		if (tenant) {
			delete (filters as any).__tenant;

			const hasAdminId = meta.columns.some((c) => c.propertyName === "adminId" || c.databaseName === "admin_id");

			if (hasAdminId) {
				// prevent caller from overriding adminId filter later
				if ((filters as any)?.adminId !== undefined) delete (filters as any).adminId;

				const adminIdCol = qualifyField("adminId");

				if (tenant.role === "super_admin") {
					qb.andWhere(`${adminIdCol} IS NULL`);
				} else if (tenant.role === "admin") {
					qb.andWhere(
						new Brackets((b) => {
							b.where(`${adminIdCol} IS NULL`).orWhere(`${adminIdCol} = :selfAdminId`, { selfAdminId: tenant.userId });
						})
					);
				} else {
					qb.andWhere(
						new Brackets((b) => {
							b.where(`${adminIdCol} IS NULL`).orWhere(`${adminIdCol} = :parentAdminId`, { parentAdminId: tenant.adminId });
						})
					);
				}
			}
		}
		// ---- end Tenant scope ----

		// ✅ FIX: join relations on the SAME qb that we execute
		if (relations?.length) {
			CRUD.joinNestedRelations(qb, repository, entityName, relations);
		}

		function applyFilter(key: string, value: any) {
			let base = key;
			let op: string | null = null;

			const knownOps = ["like", "ilike", "gt", "gte", "lt", "lte", "ne", "isnull"];
			const i = key.lastIndexOf(".");
			if (i > -1) {
				const maybeOp = key.slice(i + 1);
				if (knownOps.includes(maybeOp)) {
					base = key.slice(0, i);
					op = maybeOp;
				}
			}

			if (value === "__NULL__") {
				op = "isnull";
				value = true;
			}

			const qualified = qualifyField(base);
			const param = key.replace(/\./g, "_");

			switch (op) {
				case "like":
					qb.andWhere(`${qualified} LIKE :${param}`, { [param]: `%${value}%` });
					break;
				case "ilike":
					qb.andWhere(`${qualified} ILIKE :${param}`, { [param]: `%${value}%` });
					break;
				case "gt":
					qb.andWhere(`${qualified} > :${param}`, { [param]: value });
					break;
				case "gte":
					qb.andWhere(`${qualified} >= :${param}`, { [param]: value });
					break;
				case "lt":
					qb.andWhere(`${qualified} < :${param}`, { [param]: value });
					break;
				case "lte":
					qb.andWhere(`${qualified} <= :${param}`, { [param]: value });
					break;
				case "ne":
					qb.andWhere(`${qualified} <> :${param}`, { [param]: value });
					break;
				case "isnull":
					if (value === true || value === "true" || value === 1 || value === "1") qb.andWhere(`${qualified} IS NULL`);
					else qb.andWhere(`${qualified} IS NOT NULL`);
					break;
				default:
					if (value !== null && value !== undefined && value !== "") {
						qb.andWhere(`${qualified} = :${param}`, { [param]: value });
					}
			}
		}

		if (filters && Object.keys(filters).length) {
			const flat = flatten(filters);

			// group by base field so we can detect gte+lte => BETWEEN
			const grouped: Record<string, Record<string, any>> = {};
			for (const [k, v] of Object.entries(flat)) {
				const j = k.lastIndexOf(".");
				const base = j > -1 ? k.slice(0, j) : k;
				const op = j > -1 ? k.slice(j + 1) : "eq";
				if (!grouped[base]) grouped[base] = {};
				grouped[base][op] = v;
			}

			for (const [base, ops] of Object.entries(grouped)) {
				if (ops.gte !== undefined && ops.lte !== undefined) {
					const qualified = qualifyField(base);
					const pFrom = base.replace(/\./g, "_") + "_from";
					const pTo = base.replace(/\./g, "_") + "_to";

					qb.andWhere(`${qualified} BETWEEN :${pFrom} AND :${pTo}`, {
						[pFrom]: ops.gte,
						[pTo]: ops.lte,
					});

					// apply remaining ops if any
					for (const [op, val] of Object.entries(ops)) {
						if (op === "gte" || op === "lte") continue;
						if (op === "eq") applyFilter(base, val);
						else applyFilter(`${base}.${op}`, val);
					}
				} else {
					for (const [op, val] of Object.entries(ops)) {
						if (op === "eq") applyFilter(base, val);
						else applyFilter(`${base}.${op}`, val);
					}
				}
			}
		}

		if (search && searchFields?.length) {
			qb.andWhere(
				new Brackets((qb2) => {
					for (const field of searchFields) {
						if (field.includes(".")) {
							const qualified = qualifyField(field);
							qb2.orWhere(`LOWER(${qualified}) LIKE LOWER(:search)`, { search: `%${search}%` });
							continue;
						}
						const dbName = resolveOwnColumnName(field);
						if (!dbName) continue;
						qb2.orWhere(`LOWER(${entityName}.${dbName}) LIKE LOWER(:search)`, { search: `%${search}%` });
					}
				})
			);
		}

		// sorting
		if (sortBy?.includes(".")) {
			const qualified = qualifyField(sortBy);
			qb.orderBy(qualified, sortOrder);
		} else {
			const field = sortBy || "created_at";
			const dbName = resolveOwnColumnName(field);
			if (!dbName) {
				const available = meta.columns.map((c) => c.propertyName).join(", ");
				throw new BadRequestException(`Invalid sortBy field: '${field}'. Available: ${available}`);
			}
			qb.orderBy(`${entityName}.${dbName}`, sortOrder);
		}

		const [data, total] = await qb.getManyAndCount();

		return {
			total_records: total,
			current_page: pageNumber,
			per_page: limitNumber,
			records: data,
		};
	}


	// static async findAll<T>(repository: Repository<T>, entityName: string, search?: string, page: any = 1, limit: any = 10, sortBy?: string, sortOrder: 'ASC' | 'DESC' = 'DESC', relations?: string[], searchFields?: string[], filters?: Record<string, any>): Promise<CustomPaginatedResponse<T>> {
	// 	const pageNumber = Number(page) || 1;
	// 	const limitNumber = Number(limit) || 10;

	// 	if (isNaN(pageNumber) || isNaN(limitNumber) || pageNumber < 1 || limitNumber < 1) {
	// 		throw new BadRequestException('Pagination parameters must be valid numbers greater than 0.');
	// 	}

	// 	if (!['ASC', 'DESC'].includes(sortOrder)) {
	// 		throw new BadRequestException("Sort order must be either 'ASC' or 'DESC'.");
	// 	}

	// 	const skip = (pageNumber - 1) * limitNumber;
	// 	const query = repository.createQueryBuilder(entityName).skip(skip).take(limitNumber);

	// 	function flatten(obj: any, prefix = ''): Record<string, any> {
	// 		let result: Record<string, any> = {};
	// 		Object.entries(obj).forEach(([key, value]) => {
	// 			const prefixedKey = prefix ? `${prefix}.${key}` : key;
	// 			if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
	// 				Object.assign(result, flatten(value, prefixedKey));
	// 			} else {
	// 				result[prefixedKey] = value;
	// 			}
	// 		});
	// 		return result;
	// 	}

	// 	// ---- Tenant scope for adminId ----
	// 	const tenant = (filters as any)?.__tenant;
	// 	if (tenant) {
	// 		delete (filters as any).__tenant;

	// 		const hasAdminId = meta.columns.some(
	// 			c => c.propertyName === "adminId" || c.databaseName === "admin_id"
	// 		);

	// 		if (hasAdminId) {
	// 			// prevent caller from overriding adminId filter later
	// 			if ((filters as any)?.adminId !== undefined) delete (filters as any).adminId;

	// 			const adminIdCol = qualifyField("adminId");

	// 			if (tenant.role === "super_admin") {
	// 				qb.andWhere(`${adminIdCol} IS NULL`);
	// 			} else if (tenant.role === "admin") {
	// 				qb.andWhere(
	// 					new Brackets(b => {
	// 						b.where(`${adminIdCol} IS NULL`)
	// 							.orWhere(`${adminIdCol} = :selfAdminId`, { selfAdminId: tenant.userId });
	// 					})
	// 				);
	// 			} else {
	// 				qb.andWhere(
	// 					new Brackets(b => {
	// 						b.where(`${adminIdCol} IS NULL`)
	// 							.orWhere(`${adminIdCol} = :parentAdminId`, { parentAdminId: tenant.adminId });
	// 					})
	// 				);
	// 			}

	// 		}
	// 	}
	// 	// ---- end Tenant scope ----

	// 	if (filters && Object.keys(filters).length > 0) {
	// 		const flatFilters = flatten(filters);
	// 		Object.entries(flatFilters).forEach(([flatKey, value]) => {
	// 			if (value !== null && value !== undefined && value !== '') {
	// 				const paramKey = flatKey.replace(/\./g, '_');
	// 				query.andWhere(`${entityName}.${flatKey} = :${paramKey}`, {
	// 					[paramKey]: value,
	// 				});
	// 			}
	// 		});
	// 	}

	// 	if (search && searchFields?.length >= 1) {
	// 		query.andWhere(
	// 			new Brackets(qb => {
	// 				searchFields.forEach(field => {
	// 					const col = repository.metadata.columns.find(c => c.propertyName === field);
	// 					const typeStr = String(col?.type || '').toLowerCase();

	// 					// Enums: only exact match (don’t throw if not matched; let other fields try)
	// 					if (col?.enum && Array.isArray(col.enum)) {
	// 						if (col.enum.includes(search)) {
	// 							qb.orWhere(`${entityName}.${field} = :enumVal`, { enumVal: search });
	// 						}
	// 						return;
	// 					}

	// 					// Numbers: try exact compare if the search is numeric
	// 					const isNumericType = ['int', 'int2', 'int4', 'int8', 'integer', 'bigint', 'smallint', 'numeric', 'decimal', 'float', 'float4', 'float8', 'double precision', Number].includes(col?.type as any);

	// 					if (isNumericType) {
	// 						const n = Number(search);
	// 						if (!Number.isNaN(n)) {
	// 							qb.orWhere(`${entityName}.${field} = :n`, { n });
	// 						}
	// 						return;
	// 					}

	// 					// JSON/JSONB → cast to text + ILIKE
	// 					if (typeStr === 'jsonb' || typeStr === 'json') {
	// 						qb.orWhere(`${entityName}.${field}::text ILIKE :s`, { s: `%${search}%` });
	// 						return;
	// 					}

	// 					// Default: cast to text and ILIKE (covers varchar/text/char/uuid/date…)
	// 					qb.orWhere(`${entityName}.${field}::text ILIKE :s`, { s: `%${search}%` });
	// 				});
	// 			}),
	// 		);
	// 	}

	// 	if (relations?.length) {
	// 		CRUD.joinNestedRelations(query, repository, entityName, relations);
	// 	}

	// 	const defaultSortBy = 'created_at';
	// 	const sortField = sortBy || defaultSortBy;
	// 	const sortDirection = sortOrder || 'DESC';

	// 	const columnExists = repository.metadata.columns.some(col => col.propertyName === sortField);
	// 	if (!columnExists) {
	// 		throw new BadRequestException(`Invalid sortBy field: '${sortField}'`);
	// 	}

	// 	query.orderBy(`${entityName}.${sortField}`, sortDirection);

	// 	const [data, total] = await query.getManyAndCount();

	// 	return {
	// 		total_records: total,
	// 		current_page: pageNumber,
	// 		per_page: limitNumber,
	// 		records: data,
	// 	};
	// }

	static joinNestedRelations<T>(query: SelectQueryBuilder<T>, repository: Repository<T>, rootAlias: string, relations: string[]) {
		const addedAliases = new Set<string>();

		function validatePathAndReturnJoins(path: string) {
			const segments = path.split('.');
			let currentMeta = repository.metadata;
			let parentAlias = rootAlias;
			const steps: { joinPath: string; alias: string }[] = [];
			let aliasPath = rootAlias;

			for (const seg of segments) {
				const relMeta = currentMeta.relations.find(r => r.propertyName === seg);
				if (!relMeta) {
					throw new BadRequestException(`Invalid relation segment '${seg}' in '${path}'`);
				}
				const joinPath = `${parentAlias}.${seg}`;
				const alias = (aliasPath + '_' + seg).replace(/\./g, '_');
				steps.push({ joinPath, alias });

				parentAlias = alias;
				aliasPath = alias;
				currentMeta = relMeta.inverseEntityMetadata;
			}
			return steps;
		}

		for (const path of relations) {
			const steps = validatePathAndReturnJoins(path);
			for (const { joinPath, alias } of steps) {
				if (!addedAliases.has(alias)) {
					query.leftJoinAndSelect(joinPath, alias);
					addedAliases.add(alias);
				}
			}
		}
	}



	static async delete<T>(repository: Repository<T>, entityName: string, id: number | string): Promise<{ message: string }> {
		const entity = await repository.findOne({ where: { id } as any });

		if (!entity) {
			throw new BadRequestException(`${entityName} with ID ${id} not found.`);
		}

		await repository.delete(id);

		return {
			message: `${entityName} deleted successfully.`,
		};
	}

	static async findOne<T>(repository: Repository<T>, entityName: string, id: number | string, relations?: string[]): Promise<T> {
		const qb = repository.createQueryBuilder(entityName);


		const primaryColumns = repository.metadata.primaryColumns;
		if (!primaryColumns.length) {
			throw new BadRequestException(`${entityName} has no primary column metadata defined.`);
		}
		const primaryColumn = primaryColumns[0];
		const primaryPropName = primaryColumn.propertyName;


		qb.where(`${entityName}.${primaryPropName} = :id`, { id });


		if (relations?.length) {


			CRUD.joinNested(qb, repository, entityName, relations);
		}

		const entity = await qb.getOne();

		if (!entity) {
			throw new BadRequestException(`${entityName} with ID ${id} not found.`);
		}

		return entity;
	}


	static joinNested<T>(query: SelectQueryBuilder<T>, repository: Repository<T>, rootAlias: string, relations: string[]) {
		const addedAliases = new Set<string>();

		function validatePathAndReturnJoins(path: string) {
			const segments = path.split('.');
			let currentMeta = repository.metadata;
			let parentAlias = rootAlias;
			const steps: { joinPath: string; alias: string }[] = [];
			let aliasPath = rootAlias;

			for (const seg of segments) {
				const relMeta = currentMeta.relations.find(r => r.propertyName === seg);
				if (!relMeta) {
					throw new BadRequestException(`Invalid relation segment '${seg}' in '${path}'`);
				}
				const joinPath = `${parentAlias}.${seg}`;
				const alias = (aliasPath + '_' + seg).replace(/\./g, '_');
				steps.push({ joinPath, alias });

				parentAlias = alias;
				aliasPath = alias;
				currentMeta = relMeta.inverseEntityMetadata;
			}
			return steps;
		}

		for (const path of relations) {
			const steps = validatePathAndReturnJoins(path);
			for (const { joinPath, alias } of steps) {
				if (!addedAliases.has(alias)) {
					query.leftJoinAndSelect(joinPath, alias);
					addedAliases.add(alias);
				}
			}
		}
	}


}


