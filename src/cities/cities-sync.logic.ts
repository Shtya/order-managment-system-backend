import { Repository } from 'typeorm';
import { CityEntity, ProviderLocationEntity } from '../../entities/cities.entity';
import axios from 'axios';
import { normalizeArabic, normalizeEnglish } from '../../common/healpers';
import { citiesData } from './cities-data.config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';

export enum ShippingProviderCode {
	BOSTA = 'bosta',
	TEREBU = 'turbo',
}

export async function syncProviderLocationsLogic(
	cityRepo: Repository<CityEntity>,
	providerLocationRepo: Repository<ProviderLocationEntity>,
	logger: { log: (msg: string) => void, error: (msg: string) => void } = console
) {
	// 1. Fetch all cities from DB to build the unified map
	const allCities = await cityRepo.find();
	const unifiedCitiesMap = new Map<string, CityEntity>();

	for (const cityRecord of allCities) {
		unifiedCitiesMap.set(normalizeEnglish(cityRecord.nameEn), cityRecord);
		unifiedCitiesMap.set(normalizeArabic(cityRecord.nameAr), cityRecord);
		const stringData = citiesData.find((c) => c.nameEn === cityRecord.nameEn);

		const aliases = stringData?.aliases || [];
		aliases?.forEach((alias: string) => {
			unifiedCitiesMap.set(normalizeEnglish(alias), cityRecord);
			unifiedCitiesMap.set(normalizeArabic(alias), cityRecord);
		});
	}

	// 2. Fetch from Bosta
	let bostaRecords = [];
	try {
		const bostaResp = await axios.get(process.env.BOSTA_API_URL + '/cities');
		bostaRecords = bostaResp.data.data.list.map((city: any) => ({
			id: city._id,
			nameEn: city.name,
			nameAr: city.nameAr,
			dropOff: city.dropOffAvailability,
			pickup: city.pickupAvailability
		}));
	} catch (e: any) {
		logger.error(`❌ Failed to fetch Bosta cities: ${e.message}`);
	}

	// 3. Fetch from Turbo
	let turboRecords = [];
	try {
		const turboResp = await axios.get(process.env.TURBO_GEO_API_URL + '/external-api/get-government');
		if (turboResp.data.success) {
			turboRecords = turboResp.data.feed.map((city: any) => ({
				id: city.id,
				nameEn: city.name,
				nameAr: city.name,
				dropOff: true,
				pickup: true,
			}));
		}
	} catch (e: any) {
		logger.error(`❌ Failed to fetch Turbo cities: ${e.message}`);
	}

	// 4. Helper to seed/update
	const processRecords = async (provider: string, records: any[]) => {
		for (const record of records) {
			const matchedCity = unifiedCitiesMap.get(normalizeEnglish(record.nameEn)) ||
				unifiedCitiesMap.get(normalizeArabic(record.nameAr));

			const exists = await providerLocationRepo.findOne({
				where: { provider: provider as any, providerCityId: String(record.id) }
			});

			if (!exists) {
				await providerLocationRepo.save(providerLocationRepo.create({
					provider: provider as any,
					providerCityId: String(record.id),
					providerCityNameAr: record.nameAr || record.nameEn,
					providerCityNameEn: record.nameEn || record.nameAr,
					dropOff: record.dropOff,
					pickup: record.pickup,
					cityId: matchedCity ? matchedCity.id : null,
				}));
				// logger.log(`🚚 Seeded Provider: ${provider} | ${record.nameAr} ${matchedCity ? `(Mapped to ${matchedCity.nameEn})` : `(⚠️ Unmapped)`}`);
			} else {
				exists.cityId = matchedCity ? matchedCity.id : null;
				exists.dropOff = record.dropOff;
				exists.pickup = record.pickup;
				await providerLocationRepo.save(exists);
				// logger.log(`🔗 Updated Mapping: ${provider} | ${record.nameAr} -> ${matchedCity ? matchedCity.nameEn : 'Unmapped'}`);
			}
		}

		logger.log(`✅ Synced ${provider} provider locations for ${records.length} cities`);
	};

	await processRecords(ShippingProviderCode.BOSTA, bostaRecords);
	await processRecords(ShippingProviderCode.TEREBU, turboRecords);
}


export class CitiesSyncService {
	private readonly logger = new Logger(CitiesSyncService.name);
	constructor(
		@InjectRepository(CityEntity)
		private cityRepo: Repository<CityEntity>,
		@InjectRepository(ProviderLocationEntity)
		private providerLocationRepo: Repository<ProviderLocationEntity>,
	) { }

	// @Cron(CronExpression.EVERY_WEEK)
	// async handleWeeklySync() {
	// 	this.logger.log('Running weekly provider locations sync...');
	// 	await this.syncProviderLocations();
	// }
	
	// async syncProviderLocations() {
	// 	await syncProviderLocationsLogic(this.cityRepo, this.providerLocationRepo, this.logger);
	// }

}