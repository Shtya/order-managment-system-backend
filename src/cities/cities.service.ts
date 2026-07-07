import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { AreaEntity, CityEntity, CityTenantConfigEntity, ProviderLocationEntity } from '../../entities/cities.entity';

import { UpdateCityTenantConfigDto } from 'dto/cities.dto';
import * as ExcelJS from 'exceljs';
import { tenantId } from 'src/category/category.service';
import { DateFilterUtil } from 'common/date-filter.util';

@Injectable()
export class CitiesService {
	private readonly logger = new Logger(CitiesService.name);

	constructor(
		@InjectRepository(CityEntity)
		private cityRepo: Repository<CityEntity>,
		@InjectRepository(AreaEntity)
		private areaRepo: Repository<AreaEntity>,
		@InjectRepository(CityTenantConfigEntity)
		private tenantConfigRepo: Repository<CityTenantConfigEntity>,
	) { }



	async findAllWithProviders() {
		return this.cityRepo.find({
			relations: ['providerLocations'],
			where: { isActive: true },
			order: { nameEn: 'ASC' }
		});
	}

	async findAreas(cityId: string) {
		return this.areaRepo.find({
			where: { cityId },
			order: { nameEn: 'ASC' }
		});
	}

	async findAllWithTenantConfig(me: any, q?: any) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException('Missing adminId');

		const page = Number(q?.page ?? 1);
		const limit = Number(q?.limit ?? 10);
		const search = String(q?.search ?? '').trim();

		const qb = this.cityRepo.createQueryBuilder('city')
			.leftJoinAndSelect('city.tenantConfigs', 'config', 'config.adminId = :adminId', { adminId });

		if (search) {
			qb.andWhere(new Brackets(sq => {
				sq.where('city.nameEn ILIKE :s', { s: `%${search}%` })
					.orWhere('city.nameAr ILIKE :s', { s: `%${search}%` });
			}));
		}

		if (q?.minDays !== undefined && q?.minDays !== '') {
			qb.andWhere('config.minShippingDays >= :minDays', { minDays: Number(q.minDays) });
		}
		if (q?.maxDays !== undefined && q?.maxDays !== '') {
			qb.andWhere('config.maxShippingDays <= :maxDays', { maxDays: Number(q.maxDays) });
		}

		DateFilterUtil.applyToQueryBuilder(qb, 'config."createdAt"', q?.startDate, q?.endDate);


		if (q?.isConfigured === 'true') {
			qb.andWhere('config.id IS NOT NULL');
		} else if (q?.isConfigured === 'false') {
			qb.andWhere('config.id IS NULL');
		}

		qb.andWhere('city."isActive" = true');

		const [records, total] = await qb
			.orderBy('city.nameEn', 'ASC')
			.skip((page - 1) * limit)
			.take(limit)
			.getManyAndCount();

		return {
			total_records: total,
			current_page: page,
			per_page: limit,
			records,
		};
	}

	async exportCitiesConfig(me: any, q?: any) {
		const { records } = await this.findAllWithTenantConfig(me, { ...q, limit: 10000 });

		const workbook = new ExcelJS.Workbook();
		const worksheet = workbook.addWorksheet("Cities Configuration");

		worksheet.columns = [
			{ header: "City Name (En)", key: "nameEn", width: 25 },
			{ header: "City Name (Ar)", key: "nameAr", width: 25 },
			{ header: "Min Shipping Days", key: "minDays", width: 20 },
			{ header: "Max Shipping Days", key: "maxDays", width: 20 },
			{ header: "Status", key: "status", width: 15 },
		];

		const rows = records.map(city => {
			const config = city.tenantConfigs?.[0];
			const isConfigured = Boolean(config);
			return {
				nameEn: city.nameEn,
				nameAr: city.nameAr,
				minDays: config?.minShippingDays ?? '—',
				maxDays: config?.maxShippingDays ?? '—',
				status: isConfigured ? 'Configured' : 'Not Configured',
			};
		});

		worksheet.addRows(rows);

		// Styling
		worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
		worksheet.getRow(1).fill = {
			type: 'pattern',
			pattern: 'solid',
			fgColor: { argb: 'FF4F46E5' },
		};
		worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

		return await workbook.xlsx.writeBuffer();
	}

	async upsertTenantConfig(me: any, cityId: string, payload: UpdateCityTenantConfigDto) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException('Missing adminId');

		const city = await this.cityRepo.findOne({ where: { id: cityId } });
		if (!city) throw new NotFoundException('City not found');

		let config = await this.tenantConfigRepo.findOne({
			where: { adminId, cityId }
		});

		if (!config) {
			config = this.tenantConfigRepo.create({
				adminId,
				cityId,
				...payload
			});
		} else {
			Object.assign(config, payload);
		}

		return this.tenantConfigRepo.save(config);
	}

	async deleteTenantConfig(me: any, cityId: string) {
		const adminId = tenantId(me);
		if (!adminId) throw new BadRequestException('Missing adminId');

		const config = await this.tenantConfigRepo.findOne({
			where: { adminId, cityId }
		});

		if (!config) throw new NotFoundException('Configuration not found');

		await this.tenantConfigRepo.remove(config);
		return { success: true };
	}
}
