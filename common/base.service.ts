import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Repository, Brackets, QueryFailedError } from 'typeorm';



export async function checkEntityExists(repository: { findOne: (options: any) => Promise<any> }, id: number, message: string) {
	const entity = await repository.findOne({ where: { id } });
	if (!entity) {
		throw new NotFoundException(message);
	}
	return entity;
}

export interface FindAllOptions {
	entityName: string;
	page?: number;
	limit?: number;
	search?: string;
	sortBy?: string;
	sortOrder?: 'ASC' | 'DESC';
	searchFields?: string[];
	relations?: string[];
	fieldsExclude?: string[];
}

@Injectable()
export class BaseService<T> {
	constructor(protected readonly repository: Repository<T>) { }

	async update(id: any, dto: any) {
		const metadata: any = this.repository.metadata;

		for (const field of Object.keys(dto)) {
			const fieldExists = metadata.columns.some(column => column.propertyName === field);
			if (!fieldExists) {
				throw new BadRequestException(`Field "${field}" does not exist on "${metadata.name}".`);
			}
		}

		await this.repository.update(id, dto);
		return checkEntityExists(this.repository, id, 'Record not found.');
	}

	async create_(dto: any, relations?: string[]) {
		const metadata: any = this.repository.metadata;

		for (const field of Object.keys(dto)) {
			const fieldExists = metadata.columns.some(column => column.propertyName === field);
			if (!fieldExists) {
				throw new BadRequestException(`Field "${field}" does not exist on "${metadata.name}".`);
			}
		}

		try {
			const data = this.repository.create(dto);
			return await this.repository.save(data);
		} catch (error) {
			if (error instanceof QueryFailedError) {
				const code = (error as any)?.driverError?.code;
				// Postgres unique violation
				if (code === '23505') {
					throw new BadRequestException('Record already exists (duplicate value).');
				}
			}
			throw new BadRequestException((error as Error)?.message || 'Invalid data.');
		}
	}

	async findAll(entityName: string, search?: string, page: any = 1, limit: any = 10, sortBy?: string, sortOrder: 'ASC' | 'DESC' = 'DESC', relations?: string[], searchFields?: string[], filters?: Record<string, any>) {
		const pageNumber = Number(page) || 1;
		const limitNumber = Number(limit) || 10;

		if (isNaN(pageNumber) || isNaN(limitNumber) || pageNumber < 1 || limitNumber < 1) {
			throw new BadRequestException('Invalid pagination parameters. "page" and "limit" must be positive numbers.');
		}

		if (!['ASC', 'DESC'].includes(sortOrder)) {
			throw new BadRequestException('Invalid sort order. Use "ASC" or "DESC".');
		}

		const skip = (pageNumber - 1) * limitNumber;
		const query = this.repository.createQueryBuilder(entityName).skip(skip).take(limitNumber);

		function flatten(obj: any, prefix = ''): Record<string, any> {
			const result: Record<string, any> = {};
			Object.entries(obj).forEach(([key, value]) => {
				const prefixedKey = prefix ? `${prefix}.${key}` : key;
				if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
					Object.assign(result, flatten(value, prefixedKey));
				} else {
					result[prefixedKey] = value;
				}
			});
			return result;
		}

		// =============== Filters ==================
		if (filters && Object.keys(filters).length > 0) {
			const flatFilters = flatten(filters);
			Object.entries(flatFilters).forEach(([flatKey, value]) => {
				if (value !== null && value !== undefined && value !== '') {
					const paramKey = flatKey.replace(/\./g, '_'); // e.g. 'user.id' => 'user_id'
					query.andWhere(`${entityName}.${flatKey} = :${paramKey}`, { [paramKey]: value });
				}
			});
		}

		// =============== Search ==================
		if (search && searchFields?.length >= 1) {
			query.andWhere(
				new Brackets(qb => {
					searchFields.forEach(field => {
						const columnMetadata = this.repository.metadata.columns.find(col => col.propertyName === field);

						if (columnMetadata?.type === 'jsonb') {
							qb.orWhere(`LOWER(${entityName}.${field}::text) LIKE LOWER(:search)`, { search: `%${search}%` });
						} else if (columnMetadata?.type === String || columnMetadata?.type === 'text') {
							qb.orWhere(`LOWER(${entityName}.${field}) LIKE LOWER(:search)`, { search: `%${search}%` });
						} else if (['decimal', 'float'].includes(columnMetadata?.type as any)) {
							const numericSearch = parseFloat(search);
							if (!isNaN(numericSearch)) {
								qb.orWhere(`${entityName}.${field} = :numericSearch`, { numericSearch });
							}
						} else if (columnMetadata?.type === 'enum') {
							const enumValues = columnMetadata.enum as string[];
							if (enumValues?.includes(search)) {
								qb.orWhere(`${entityName}.${field} = :value`, { value: search });
							} else {
								throw new BadRequestException(`Invalid value for "${field}". Allowed: ${enumValues?.join(', ') || '(none)'}`);
							}
						} else {
							qb.orWhere(`${entityName}.${field} = :search`, { search });
						}
					});
				}),
			);
		}

		// =============== Relations ==================
		if (relations?.length > 0) {
			const invalidRelations = relations.filter(relation => !this.repository.metadata.relations.some(rel => rel.propertyName === relation));
			if (invalidRelations.length > 0) {
				throw new BadRequestException(`Invalid relations: ${invalidRelations.join(', ')}.`);
			}
			relations.forEach(relation => {
				query.leftJoinAndSelect(`${entityName}.${relation}`, relation);
			});
		}

		// =============== Sorting ==================
		const defaultSortBy = 'created_at';
		const sortField = sortBy || defaultSortBy;
		const sortDirection = sortOrder || 'DESC';

		const columnExists = this.repository.metadata.columns.some(col => col.propertyName === sortField);
		if (!columnExists) {
			throw new BadRequestException(`Invalid "sortBy" value: "${sortField}".`);
		}
		query.orderBy(`${entityName}.${sortField}`, sortDirection);

		// Fetch data
		const [data, total] = (await query.getManyAndCount()) as any;

		return {
			total_records: total,
			current_page: pageNumber,
			per_page: limitNumber,
			records: data,
		};
	}

	async findOne(id: any, relations?: string[]) {
		const entity: any = await this.repository.findOne({ where: { id } as any, relations });
		if (!entity) {
			throw new NotFoundException(`Record with id "${id}" was not found.`);
		}
		return entity;
	}

	async remove(id: any) {
		await checkEntityExists(this.repository, id, 'Record not found.');
		await this.repository.delete(id);
		return { message: `Record "${id}" deleted successfully.` };
	}
}
