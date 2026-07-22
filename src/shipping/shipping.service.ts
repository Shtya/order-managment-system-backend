// --- File: backend/src/shipping/shipping.service.ts ---
import { BadRequestException, forwardRef, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Not, Repository } from 'typeorm';
import * as crypto from 'crypto';


import {
	ShipmentEntity,
	ShipmentEventEntity,
	ShipmentStatus,
	ShippingCompanyEntity,
	ShippingIntegrationEntity,
	UnifiedShippingStatus,
	ExternalShipmentLogEntity,
} from '../../entities/shipping.entity';
import { DateFilterUtil } from 'common/date-filter.util';
import * as ExcelJS from 'exceljs';

import { AssignOrderDto, BulkAssignOrderDto, CreateShipmentDto, ManualUpdateShipmentStatusDto, PrintMassAWBDto } from 'dto/shipping.dto';
import { IMassAWBProvider, ProviderCode, ProviderWebhookResult, ShippingProvider } from './providers/shipping-provider.interface';
import { BostaProvider } from './providers/bosta.provider';
import { JtProvider } from './providers/jt.provider';
import { TurboProvider } from './providers/turbo.provider';
import { tenantId } from 'src/category/category.service';
import { OrderActionResult, OrderActionType, OrderEntity, OrderItemEntity, OrderReplacementEntity, OrderStatus, OrderStatusEntity } from 'entities/order.entity';
import { ProductVariantEntity } from 'entities/sku.entity';
import { OrdersService } from 'src/orders/services/orders.service';
import { OrderSyncQueueService } from 'src/queue/queues/order-sync.queue';
import { AppGateway } from '../../common/app.gateway';
import { NotificationService } from 'src/notifications/notification.service';
import { NotificationType } from 'entities/notifications.entity';
import { generateRandomAlphanumeric, isSuperAdmin } from 'common/healpers';
import { TriggerDispatcherService } from 'src/automation/engine/triggerDispatcher.service';
import { TriggerEntityType, TriggerType } from 'entities/automation.entity';
import { OrderFlowPath } from 'entities/clientSettings.entity';
import { ClientSettingsService } from 'src/client-settings/client-settings.service';
import { RequestTranslationService, TranslationService } from 'common/translation.service';

@Injectable()
export class ShippingService {
	private providers: Record<ProviderCode, ShippingProvider>;

	constructor(
		private bostaProvider: BostaProvider,
		private jtProvider: JtProvider,
		private orderSyncQueueService: OrderSyncQueueService,

		private turboProvider: TurboProvider,
		private dataSource: DataSource,
		private appGateway: AppGateway,
		@InjectRepository(ShippingCompanyEntity)
		private companiesRepo: Repository<ShippingCompanyEntity>,

		@InjectRepository(OrderEntity)
		private ordersRepo: Repository<OrderEntity>,

		@InjectRepository(ShippingIntegrationEntity)
		private integrationsRepo: Repository<ShippingIntegrationEntity>,

		@InjectRepository(ShipmentEntity)
		private shipmentsRepo: Repository<ShipmentEntity>,

		@InjectRepository(ShipmentEventEntity)
		private eventsRepo: Repository<ShipmentEventEntity>,
		@InjectRepository(ExternalShipmentLogEntity)
		private externalShipmentLogsRepo: Repository<ExternalShipmentLogEntity>,
		@Inject(forwardRef(() => OrdersService))
		private readonly ordersService: OrdersService,
		private readonly notificationService: NotificationService,
		@Inject(forwardRef(() => TriggerDispatcherService))
		private readonly triggerDispatcher: TriggerDispatcherService,
		private readonly clientSettingsService: ClientSettingsService,
		private readonly translations: TranslationService,
		private requestTranslations: RequestTranslationService,
	) {
		this.providers = {
			bosta: this.bostaProvider,
			jt: this.jtProvider,
			turbo: this.turboProvider,
			aramex: null,
			dhl: null,
			SMSA: null
		};
	}


	// backend/src/shipping/shipping.service.ts
	async getIntegrationsStatus(adminId: string) {
		// ✅ GLOBAL companies
		const companies = await this.companiesRepo.find({ order: { id: "ASC" as any } });

		// per-admin integrations
		const integrations = await this.integrationsRepo.find({ where: { adminId } });

		const integByCompanyId = new Map<string, ShippingIntegrationEntity>();
		for (const integ of integrations) integByCompanyId.set(integ.shippingCompanyId, integ);

		const result = companies.map((company) => {
			const integ = integByCompanyId.get(company.id);
			return {
				provider: company.code,
				name: company.name,
				isActive: integ?.isActive ?? false,
				credentialsConfigured: !!(integ?.credentials?.apiKey),
				credentials: this.maskCredentials(integ?.credentials),
				// optional UI info if you want to return it here
				logo: company.logo,
				website: company.website,
				bg: company.bg,
				description: company.description,
			};
		});

		return { ok: true, integrations: result };
	}

	async activeIntegrations(user: any) {
		const superAdmin = isSuperAdmin(user);

		if (superAdmin) {
			const companies = await this.companiesRepo.find();

			const result = companies.map((company) => ({
				id: company.id,
				provider: company.code,
				providerId: company.id,
				name: company.name,
				logo: company.logo,
			}));

			return {
				ok: true,
				integrations: result
			};
		}

		// 2. إذا كان مستخدم عادي (Tenant)، يستمر المنطق القديم بالتقيد بالـ adminId الخاص به والـ API Key
		const adminId = tenantId(user);
		const integrations = await this.integrationsRepo.find({
			where: {
				adminId,
				isActive: true
			},
			relations: ['shippingCompany']
		});

		const result = integrations
			.filter(integ => !!integ.credentials?.apiKey)
			.map((integ) => ({
				id: integ.id,
				provider: integ.shippingCompany?.code,
				providerId: integ.shippingCompany?.id,
				name: integ.shippingCompany?.name,
				logo: integ.shippingCompany?.logo,
			}));

		return {
			ok: true,
			integrations: result
		};
	}

	async getShipmentStatus(adminId: string, provider: string, trackingNumber: string) {
		const p = this.getProvider(provider);
		const { apiKey } = await this.requireApiKey(adminId, provider);

		return p.getShipmentStatus(apiKey, trackingNumber);
	}

	async printMassAWB(me: any, providerCode: string, dto: PrintMassAWBDto) {
		const adminId = tenantId(me);
		const p = this.getProvider(providerCode);

		if (!("printMassAWB" in p)) {
			throw new BadRequestException(
				this.translations.t("domains.shipping.provider_not_support_mass_awb", {
					args: {
						providerCode,
					},
				}),
			);
		}

		const massAWBProvider = p as unknown as IMassAWBProvider;

		if (dto.orderIds.length > 50) {
			throw new BadRequestException(
				this.translations.t("domains.shipping.mass_awb_max_orders"),
			);
		}

		const orders = await this.ordersRepo.find({
			where: {
				id: In(dto.orderIds),
				adminId,
				shippingCompany: {
					code: providerCode,
				},
			},
			relations: ["status", "shippingCompany"],
		});

		if (orders.length !== dto.orderIds.length) {
			throw new BadRequestException(
				this.translations.t(
					"domains.shipping.orders_not_found_or_invalid_provider",
				),
			);
		}

		const trackingNumbers: string[] = [];

		for (const order of orders) {
			if (!order.trackingNumber) {
				throw new BadRequestException(
					this.translations.t(
						"domains.shipping.order_missing_tracking_number",
						{
							args: {
								orderNumber: order.orderNumber,
							},
						},
					),
				);
			}

			if (
				![
					OrderStatus.DISTRIBUTED,
					OrderStatus.SHIPPED,
					OrderStatus.PRINTED,
				].includes(order.status?.code as OrderStatus)
			) {
				throw new BadRequestException(
					this.translations.t(
						"domains.shipping.order_invalid_awb_status",
						{
							args: {
								orderNumber: order.orderNumber,
								status: order.status?.code,
							},
						},
					),
				);
			}

			trackingNumbers.push(order.trackingNumber);
		}

		const { apiKey } = await this.requireApiKey(
			adminId,
			providerCode,
		);

		const result = await massAWBProvider.printMassAWB(
			apiKey,
			trackingNumbers,
			{
				requestedAwbType: dto.requestedAwbType,
				lang: dto.lang,
			},
		);

		if (!result.success) {
			throw new BadRequestException(result.error);
		}

		return {
			success: true,
			data: result.data,
		};
	}

	private maskCredentials(credentials: any) {
		if (!credentials) return null;

		const masked = { ...credentials };
		const sensitiveKeys = ['apiKey'];

		sensitiveKeys.forEach((key) => {
			const value = masked[key];
			if (value && typeof value === 'string') {
				masked[key] = value.length > 8
					? `${value.substring(0, 4)}****************${value.slice(-4)}`
					: "****************";
			}
		});

		return masked;
	}


	listProviders() {
		return {
			ok: true,
			providers: Object.values(this.providers).filter(p => !!p).map((p) => ({
				code: p.code,
				name: p.displayName,
			})),
		};
	}

	private getProvider(provider: string | ProviderCode): ShippingProvider {
		const key = (provider || '').toLowerCase().trim();
		const p = this.providers[key];
		if (!p) throw new BadRequestException(this.translations.t("domains.shipping.unsupported_provider", {
			args: {
				provider,
			},
		}));
		return p;
	}

	private async getCompanyByProviderForAdmin(_adminId: string, provider: string) {

		const company = await this.companiesRepo.findOne({ where: { code: provider } });
		if (!company) throw new BadRequestException(this.translations.t("domains.shipping.company_not_found", {
			args: {
				provider,
			},
		}));
		return company;
	}


	private async getOrCreateIntegration(adminId: string, companyId: string) {
		let integ = await this.integrationsRepo.findOne({ where: { adminId, shippingCompanyId: companyId } });
		if (!integ) {
			integ = await this.integrationsRepo.save(
				this.integrationsRepo.create({
					adminId,
					shippingCompanyId: companyId,
					isActive: false,
					credentials: null,
				}),
			);
		}
		return integ;
	}

	private async requireApiKey(adminId: string, provider: string): Promise<{ apiKey: string; companyId: string; integId: string, integ: ShippingIntegrationEntity }> {
		const company = await this.getCompanyByProviderForAdmin(adminId, provider);
		const integ = await this.getOrCreateIntegration(adminId, company.id);

		if (!integ.isActive) throw new BadRequestException(this.translations.t("domains.shipping.integration_disabled"));

		const apiKey = integ.credentials?.apiKey;

		if (!apiKey) throw new BadRequestException(this.translations.t("domains.shipping.credentials_not_configured"));

		return { apiKey, companyId: company.id, integId: integ.id, integ };
	}

	private async validateProviderConnection(provider, integ: ShippingIntegrationEntity): Promise<void> {
		const p = this.getProvider(provider);

		const accountId = integ?.credentials?.accountId ? String(integ?.credentials?.accountId).trim() : (integ?.credentials?.accountId || undefined)
		const apiKey = integ?.credentials?.apiKey;

		const { valid, message } = await p.verifyCredentials(apiKey, accountId);
		if (!valid) {
			throw new BadRequestException(
				message || this.translations.t("domains.shipping.connection_failed", { args: { provider } }),
			);
		}


	}

	async setCredentials(adminId: string, provider: string, credentials: any) {
		const company = await this.getCompanyByProviderForAdmin(adminId, provider);
		console.log(credentials);
		const integ = await this.getOrCreateIntegration(adminId, company.id);

		const next = {
			...(integ.credentials || {}),
			apiKey: credentials.apiKey ? String(credentials.apiKey).trim() : (integ.credentials?.apiKey || undefined),
			accountId: credentials.accountId ? String(credentials.accountId).trim() : (integ.credentials?.accountId || undefined),

			// optional webhook config persistence
			webhookHeaderName: credentials.webhookHeaderName ? String(credentials.webhookHeaderName).trim() : (integ.credentials?.webhookHeaderName || undefined),
			webhookSecret: credentials.webhookSecret ? String(credentials.webhookSecret).trim() : (integ.credentials?.webhookSecret || undefined),
		};

		if (!next.apiKey) throw new BadRequestException(this.translations.t("domains.shipping.api_key_missing"));

		await this.dataSource.transaction(async (manager) => {

			integ.credentials = next;
			integ.isActive = true;

			await manager.save(integ);


			await this.validateProviderConnection(provider, integ);

		});

		return {
			ok: true,
			provider,
			isActive: integ.isActive,
			credentialsConfigured: true,
		};
	}

	async setActive(adminId: string, provider: string, isActive: boolean) {
		const company = await this.getCompanyByProviderForAdmin(adminId, provider);
		const p = this.getProvider(provider);
		const integ = await this.getOrCreateIntegration(adminId, company.id);

		if (isActive) {
			const apiKey = integ.credentials?.apiKey;
			if (!apiKey) {
				throw new BadRequestException(this.translations.t("domains.shipping.api_key_not_found", { args: { provider } }));
			}


			await this.validateProviderConnection(provider, integ);

		}
		integ.isActive = isActive;
		await this.integrationsRepo.save(integ);
		return { ok: true, provider, isActive };
	}

	async getServices(adminId: string, provider: string) {
		const p = this.getProvider(provider);
		const { apiKey } = await this.requireApiKey(adminId, provider);

		const services = await p.getServices(apiKey);
		return { ok: true, provider: p.code, services };
	}

	async getCapabilities(adminId: string, provider: string) {
		const p = this.getProvider(provider);
		const { apiKey } = await this.requireApiKey(adminId, provider);
		const caps = await p.getCapabilities(apiKey);
		return { ok: true, provider: p.code, capabilities: caps };
	}

	// async getAreas(adminId: string, provider: string, countryId: string) {
	// 	const p = this.getProvider(provider);
	// 	await this.requireApiKey(adminId, provider);
	// 	const areas = await p.getAreas(countryId);

	// 	return {
	// 		ok: true,
	// 		provider: p.code,
	// 		records: areas,
	// 	};
	// }

	async getCities(adminId: string, provider: string) {
		const p = this.getProvider(provider);
		const { apiKey } = await this.requireApiKey(adminId, provider);
		const cities = await p.getCities(apiKey);

		return {
			ok: true,
			provider: p.code,
			records: cities,
		};
	}

	async getDistricts(adminId: string, provider: string, cityId: string) {
		const p = this.getProvider(provider);
		const { apiKey } = await this.requireApiKey(adminId, provider);
		const districts = await p.getDistricts(apiKey, cityId);

		return {
			ok: true,
			provider: p.code,
			records: districts,
		};
	}

	async getZones(adminId: string, provider: string, cityId: string) {
		const p = this.getProvider(provider);
		const { apiKey } = await this.requireApiKey(adminId, provider);
		const zones = await p.getZones(apiKey, cityId);

		return {
			ok: true,
			provider: p.code,
			records: zones,
		};
	}

	async getPickupLocations(adminId: string, providerCode: string) {
		const provider = this.getProvider(providerCode);
		const { apiKey } = await this.requireApiKey(adminId, providerCode);

		const location = await provider.getPickupLocations(apiKey);

		return {
			ok: true,
			provider: provider,
			records: location,
		};
	}

	async createShipment(me, provider: ProviderCode | 'none', dto: CreateShipmentDto, orderId: string
		, options: { emitSocket?: boolean } = { emitSocket: true }) {
		const adminId = tenantId(me);
		const userId = me?.id;
		let order: any;
		const shipment: ShipmentEntity = null;
		try {
			// Validation: Order ID required
			if (!orderId) {
				throw new BadRequestException(this.translations.t("domains.shipping.order_required"));
			}

			// Validation: Order exists
			order = await this.ordersRepo.findOne({
				where: { id: orderId, adminId },
				relations: [
					"status",
					'items',
					'items.variant',
					'items.variant.product',
					'replacementResult',
					'replacementResult.items',
					'replacementResult.items.originalOrderItem',
					'replacementResult.items.originalOrderItem.variant',
					'replacementResult.items.originalOrderItem.variant.product'
				]
			});

			if (!order) throw new BadRequestException(this.translations.t("domains.shipping.order_not_found"));

			// Validation: Order status
			if (![OrderStatus.CONFIRMED, OrderStatus.FAILED_DELIVERY].includes(order.status?.code as OrderStatus)) {
				throw new BadRequestException(this.translations.t("domains.shipping.invalid_order_status", { args: { status: order.status?.code } }));
			}

			// Cancel previous shipment if exists (latest for this order)
			const prevShipment = await this.shipmentsRepo.findOne({
				where: {
					orderId: order.id,
					adminId,
				},
				order: { created_at: 'DESC' as any },
				relations: ['shippingCompany'],
			});

			if (prevShipment && ![ShipmentStatus.CANCELLED, ShipmentStatus.FAILED].includes(prevShipment.status)) {
				try {
					if (!prevShipment.shippingCompanyId) {
						await this.cancelManualShipment(me, prevShipment.id);
					} else {
						await this.cancelShipment({ id: adminId, adminId, role: { name: 'admin' } }, prevShipment.shippingCompany.code, prevShipment.id);
					}
				} catch (e: any) {
					const prevTracking = prevShipment?.trackingNumber || prevShipment?.providerShipmentId;
					throw new BadRequestException(
						this.translations.t("domains.shipping.previous_shipment_not_cancelled", { args: { prevTracking } })
					);
				}
			}

			// Setup provider and API key
			const isNoneProvider = provider === 'none';
			const p = !isNoneProvider ? this.getProvider(provider) : null;
			const { apiKey, companyId, integ } = !isNoneProvider
				? await this.requireApiKey(adminId, provider)
				: { apiKey: null, companyId: null, integ: null };

			// Execute shipment creation transaction
			const result = await this.dataSource.transaction(async (manager) => {
				const settings = await this.clientSettingsService.getCachedSettings(adminId);
				const newStatusCode = settings.orderFlowPath === OrderFlowPath.SHIPPING ? OrderStatus.SHIPPED : OrderStatus.DISTRIBUTED;

				// Function to dispatch shipment created trigger after commit
				const dispatchShipmentCreated = async (shipmentId: string) => {
					try {
						const fullOrder = await manager.findOne(OrderEntity, {
							where: { id: orderId },
							relations: ['status', 'items', 'items.variant', "items.variant.product"],
						});

						if (fullOrder) {
							await this.triggerDispatcher.dispatch({
								type: TriggerType.SHIPMENT_CREATED,
								entityType: TriggerEntityType.ORDER,
								entityId: fullOrder.id,
								adminId: fullOrder.adminId,
								payload: fullOrder,
							});
						}
					} catch (error) {
						console.error("Error dispatching SHIPMENT_CREATED trigger:", error);
					}
				};

				if (isNoneProvider) {
					const status = await this.ordersService.findStatusByCode(newStatusCode, adminId, manager);

					const trackingNumber = await this.generateUniqueManualTrackingNumber(adminId, manager);

					const manualShipment = await manager.save(
						manager.create(ShipmentEntity, {
							adminId,
							orderId,
							shippingCompanyId: null,
							status: ShipmentStatus.PENDING_ACTION,
							cityId: order.cityId,
							address: order.address,
							landmark: order.landmark,
							area: order.area,
							unifiedStatus: UnifiedShippingStatus.IN_PROGRESS,
							trackingNumber,
							providerRaw: { manual: true },
						}),
					);

					await manager.update(
						OrderEntity,
						{ id: orderId, adminId },
						{
							statusId: status.id,
							trackingNumber,
							shippingCompanyId: null,
							distributed_at: new Date(),
						},
					);

					await this.ordersService.logOrderAction({
						manager,
						adminId,
						userId,
						orderId,
						actionType: OrderActionType.COURIER_ASSIGNED,
						result: OrderActionResult.SUCCESS,
						details: await this.requestTranslations.tAsync("domains.shipping.courier_assigned_manual", adminId, { args: { trackingNumber } }),
					});

					await manager.save(
						manager.create(ShipmentEventEntity, {
							shipmentId: manualShipment.id,
							source: 'system' as any,
							eventType: 'status_changed',
							payload: { manualCreated: true, trackingNumber },
						}),
					);

					// Add post-commit task to dispatch trigger
					const queryRunner = manager.queryRunner;
					if (queryRunner) {
						if (!queryRunner.data.postCommitTasks) {
							queryRunner.data.postCommitTasks = [];
						}
						queryRunner.data.postCommitTasks.push(() => dispatchShipmentCreated(manualShipment.id));
					} else {
						await dispatchShipmentCreated(manualShipment.id);
					}

					return {
						ok: true,
						shipmentId: manualShipment.id,
						orderId: orderId,
						provider: 'none',
						trackingNumber,
						status: UnifiedShippingStatus.IN_PROGRESS,
					};
				}

				const shipment = await manager.save(
					manager.create(ShipmentEntity, {
						adminId,
						orderId: orderId,
						cityId: order.cityId,
						address: order.address,
						landmark: order.landmark,
						area: order.area,
						shippingCompanyId: companyId,
						status: ShipmentStatus.PENDING_ACTION,
						unifiedStatus: UnifiedShippingStatus.NEW,
					}),
				);

				// Build delivery payload
				const payloadResult = await p.buildDeliveryPayload(order, dto, integ);

				if (!payloadResult.success) {
					throw new BadRequestException(payloadResult.error);
				}
				const payload = payloadResult.data;


				const res = await p.createShipment(apiKey, payload);

				shipment.trackingNumber = res.trackingNumber || null;
				shipment.providerShipmentId = res.providerShipmentId || null;
				// shipment.status = ShipmentStatus.PENDING_ACTION;
				shipment.unifiedStatus = UnifiedShippingStatus.IN_PROGRESS;
				shipment.providerRaw = {
					request: payload,
					response: res.providerRaw || { trackingNumber: shipment.trackingNumber, providerShipmentId: shipment.providerShipmentId },
				};

				await manager.save(shipment);
				const status = await this.ordersService.findStatusByCode(newStatusCode, adminId, manager)

				await manager.update(OrderEntity,
					{ id: orderId, adminId },
					{
						statusId: status.id,
						trackingNumber: shipment.trackingNumber,
						shippingCompanyId: companyId,
						distributed_at: new Date(),
					}
				);

				await this.ordersService.logOrderAction({
					manager, adminId, userId, orderId,
					actionType: OrderActionType.COURIER_ASSIGNED,
					result: OrderActionResult.SUCCESS,
					shippingCompanyId: companyId,
					details: await this.requestTranslations.tAsync("domains.shipping.courier_assigned_provider", adminId, { args: { provider, trackingNumber: shipment.trackingNumber } }),
				});

				// Add post-commit task to dispatch trigger
				const queryRunner = manager.queryRunner;
				if (queryRunner) {
					if (!queryRunner.data.postCommitTasks) {
						queryRunner.data.postCommitTasks = [];
					}
					queryRunner.data.postCommitTasks.push(() => dispatchShipmentCreated(shipment.id));
				} else {
					await dispatchShipmentCreated(shipment.id);
				}

				return {
					ok: true,
					shipmentId: shipment.id,
					orderId: shipment.orderId,
					provider,
					trackingNumber: shipment.trackingNumber,
					providerShipmentId: shipment.providerShipmentId,
					status: shipment.unifiedStatus,
				};
			});

			// Success path
			if (options.emitSocket !== false) {
				this.appGateway.emitShipmentStatus(adminId, {
					orderId,
					orderNumber: order.orderNumber,
					shipmentId: result.shipmentId,
					status: 'success',
					trackingNumber: result.trackingNumber,
				});
			}

			await this.notificationService.create({
				userId: adminId,
				type: NotificationType.SHIPMENT_CREATED,
				title:
					provider === "none"
						? await this.requestTranslations.tAsync("domains.shipping.order_distributed_title", adminId)
						: await this.requestTranslations.tAsync("domains.shipping.shipment_created_title", adminId),
				message: provider === 'none'
					? await this.requestTranslations.tAsync("domains.shipping.manual_shipping_assigned", adminId, { args: { orderNumber: order.orderNumber, trackingNumber: result.trackingNumber ?? '—' } })
					: await this.requestTranslations.tAsync("domains.shipping.shipment_created_successfully", adminId, { args: { orderNumber: order.orderNumber, trackingNumber: result.trackingNumber } }),
				relatedEntityType: "order",
				relatedEntityId: String(order.id),
			});

			return result;

		} catch (error: any) {
			// Single error handling
			const errorMessage = error.response?.data?.error_msg || error?.response?.message || error?.response?.data?.message || error.message || 'Shipment creation failed';

			if (options.emitSocket !== false) {
				this.appGateway.emitShipmentStatus(adminId, {
					orderId,
					orderNumber: order?.orderNumber,
					status: 'failed',
					message: errorMessage,
				});
			}
			if (shipment) {
				shipment.status = ShipmentStatus.FAILED;
				shipment.unifiedStatus = UnifiedShippingStatus.EXCEPTION;
				shipment.failureReason = errorMessage;
			}

			// Single log entry
			await this.ordersService.logOrderAction({
				adminId, userId, orderId,
				actionType: OrderActionType.COURIER_ASSIGNED,
				result: OrderActionResult.FAILED,
				details: errorMessage
			});

			// Single notification
			await this.notificationService.create({
				userId: adminId,
				type: NotificationType.SHIPMENT_CREATED,
				title: await this.requestTranslations.tAsync("domains.shipping.shipment_creation_failed", adminId),
				message: await this.requestTranslations.tAsync("domains.shipping.shipment_failed_message", adminId, { args: { orderNumber: order?.orderNumber, errorMessage: errorMessage } }),
				relatedEntityType: "order",
				relatedEntityId: String(order?.id),
			});

			throw new BadRequestException(errorMessage);
		}
	}

	async cancelShipment(me, provider: string, shipmentId: string) {
		const adminId = tenantId(me);
		const p = this.getProvider(provider);
		const { apiKey } = await this.requireApiKey(adminId, provider);

		const shipment = await this.shipmentsRepo.findOne({
			where: { id: shipmentId, adminId },
			relations: ['order', 'order.items']
		});

		if (!shipment) throw new NotFoundException(this.translations.t("domains.shipping.shipment_not_found"));
		if (shipment.status === ShipmentStatus.CANCELLED) {
			throw new BadRequestException(this.translations.t("domains.shipping.shipment_already_cancelled"));
		}

		return await this.dataSource.transaction(async (manager) => {
			try {
				const isCancelled = await p.cancelShipment(apiKey, shipment.providerShipmentId || shipment.trackingNumber);

				if (!isCancelled) {
					throw new Error(this.translations.t("domains.shipping.provider_cancel_failed"));
				}

				shipment.status = ShipmentStatus.CANCELLED;
				shipment.unifiedStatus = UnifiedShippingStatus.CANCELLED;
				await manager.save(shipment);

				const result = {
					ok: true,
					message: this.translations.t("domains.shipping.shipment_cancel_success"),
					shipmentId: shipment.id,
					status: shipment.unifiedStatus
				};

				await this.notificationService.create({
					userId: adminId,
					type: NotificationType.SHIPMENT_CANCELLED,
					title: await this.requestTranslations.tAsync("domains.shipping.shipment_cancelled_title", adminId),
					message: await this.requestTranslations.tAsync("domains.shipping.shipment_cancelled_message", adminId, { args: { orderNumber: shipment.order.orderNumber } }),
					relatedEntityType: "order",
					relatedEntityId: String(shipment.order.id),
				});

				return result;

			} catch (e: any) {
				shipment.failureReason = e?.message || 'Cancel shipment failed';
				await manager.save(shipment);

				throw new BadRequestException(`${shipment.failureReason}`);
			}
		});
	}

	// Remains direct for speed
	async assignOrder(me: any, orderId: string, dto: AssignOrderDto, provider?: ProviderCode | 'none') {
		const adminId = tenantId(me);
		return this.createShipment(me, provider, dto, orderId, { emitSocket: false });
	}

	async bulkAssignOrders(me: any, provider: ProviderCode, dto: BulkAssignOrderDto) {
		const adminId = tenantId(me);
		await this.orderSyncQueueService.enqueueBulkShippingTasks(adminId, provider, dto);
		return {
			success: true,
			message: await this.translations.t("domains.shipping.bulk_shipping_enqueued", { args: { count: dto.items.length } }),
			count: dto.items.length
		};
	}

	async listShipments(adminId: string) {
		const shipments = await this.shipmentsRepo.find({
			where: { adminId },
			order: { created_at: 'DESC' as any },
			take: 200,
		});

		return {
			ok: true,
			items: shipments.map((s) => ({
				id: s.id,
				orderId: s.orderId,
				companyId: s.shippingCompanyId,
				company: s.shippingCompany?.name,
				trackingNumber: s.trackingNumber,
				status: s.unifiedStatus,
				created_at: s.created_at,
			})),
		};
	}

	async getShipment(adminId: string, id: string) {
		const s = await this.shipmentsRepo.findOne({ where: { id, adminId } });
		if (!s) throw new BadRequestException(this.translations.t("domains.shipping.shipment_not_found"));

		return {
			ok: true,
			id: s.id,
			orderId: s.orderId,
			companyId: s.shippingCompanyId,
			company: s.shippingCompany?.name,
			trackingNumber: s.trackingNumber,
			providerShipmentId: s.providerShipmentId,
			status: s.unifiedStatus,
			created_at: s.created_at,
			updated_at: s.updated_at,
		};
	}

	async getShipmentByTrackingNumber(adminId: string, trackingNumber: string) {
		const s = await this.shipmentsRepo.findOne({ where: { trackingNumber, adminId } });
		if (!s) throw new BadRequestException(this.translations.t("domains.shipping.shipment_not_found"));

		return {
			ok: true,
			id: s.id,
			orderId: s.orderId,
			companyId: s.shippingCompanyId,
			company: s.shippingCompany?.name,
			trackingNumber: s.trackingNumber,
			providerShipmentId: s.providerShipmentId,
			status: s.unifiedStatus,
			created_at: s.created_at,
			updated_at: s.updated_at,
		};
	}

	async getShipmentEvents(adminId: string, id: string) {
		const s = await this.shipmentsRepo.findOne({ where: { id, adminId } });
		if (!s) throw new BadRequestException(this.translations.t("domains.shipping.shipment_not_found"));

		const events = await this.eventsRepo.find({
			where: { shipmentId: s.id },
			order: { created_at: 'DESC' as any },
			take: 200,
		});

		return {
			ok: true,
			shipmentId: s.id,
			events: events.map((e) => ({
				id: e.id,
				source: e.source,
				eventType: e.eventType,
				payload: e.payload,
				created_at: e.created_at,
			})),
		};
	}

	getUnifiedStatuses() {
		// Define the statuses in the exact order they should appear
		const orderedStatuses = [
			ShipmentStatus.PENDING_ACTION,
			ShipmentStatus.PREPARING,
			ShipmentStatus.READY_TO_SHIP,
			ShipmentStatus.OUT_FOR_DELIVERY,
			ShipmentStatus.DELIVERED,
			ShipmentStatus.RETURNED_TO_WAREHOUSE,
			ShipmentStatus.FAILED,
			ShipmentStatus.CANCELLED,
		];
		return { ok: true, statuses: orderedStatuses };
	}

	async listExternalShipmentLogs(me: any, q?: any) {
		const adminId = tenantId(me);
		const orderId = q?.orderId;
		const shipmentId = q?.shipmentId;
		const page = Number(q?.page ?? 1);
		const limit = Number(q?.limit ?? 10);

		const qb = this.externalShipmentLogsRepo.createQueryBuilder('log')
			.leftJoinAndSelect('log.shipment', 'shipment')
			.leftJoinAndSelect('log.order', 'order')
			.leftJoin('shipment.shippingCompany', 'shippingCompany')
			.where('shipment.adminId = :adminId', { adminId });

		if (shipmentId) {
			qb.andWhere('log.shipmentId = :shipmentId', { shipmentId });
		}
		if (orderId) {
			qb.andWhere('log.orderId = :orderId', { orderId });
		}

		DateFilterUtil.applyToQueryBuilder(qb, 'log.created_at', q?.startDate, q?.endDate);

		qb.orderBy('log.created_at', 'DESC');

		const [records, total] = await qb
			.skip((page - 1) * limit)
			.take(limit)
			.getManyAndCount();

		return { total_records: total, current_page: page, per_page: limit, records };
	}

	async exportExternalShipmentLogs(me: any, q?: any) {
		const { records } = await this.listExternalShipmentLogs(me, { ...q, limit: 1000, page: 1 });
		const workbook = new ExcelJS.Workbook();
		const worksheet = workbook.addWorksheet(this.translations.t("domains.shipping.external_shipment_logs"));

		worksheet.columns = [
			{
				header: this.translations.t("domains.shipping.order_number"),
				key: "orderNumber",
				width: 25,
			},
			{
				header: this.translations.t("domains.shipping.tracking_number"),
				key: "trackingNumber",
				width: 25,
			},
			{
				header: this.translations.t("domains.shipping.shipping_company"),
				key: "shippingCompany",
				width: 25,
			},
			{
				header: this.translations.t("domains.shipping.status"),
				key: "rawStatus",
				width: 20,
			},
			{
				header: this.translations.t("domains.shipping.notes"),
				key: "notes",
				width: 30,
			},
			{
				header: this.translations.t("domains.shipping.created_at"),
				key: "createdAt",
				width: 25,
			},
		];

		worksheet.getRow(1).font = { bold: true };
		worksheet.getRow(1).fill = {
			type: 'pattern',
			pattern: 'solid',
			fgColor: { argb: 'FFE0E0E0' },
		};

		records.forEach(log => {
			worksheet.addRow({
				orderNumber: log.order.orderNumber || 'N/A',
				trackingNumber: log.shipment?.trackingNumber || 'N/A',
				shippingCompany: log.shipment?.shippingCompany?.name || 'N/A',
				rawStatus: log.rawStatus || 'N/A',
				notes: log.notes || 'N/A',
				createdAt: log.created_at,
			});
		});

		return await workbook.xlsx.writeBuffer();
	}

	async trackShipment(me: any, trackingNumber: string) {
		const adminId = tenantId(me);
		const shipment = await this.shipmentsRepo.findOne({
			where: { trackingNumber, adminId },
			relations: ['shippingCompany']
		});
		if (!shipment) throw new BadRequestException(this.translations.t("domains.shipping.shipment_not_found"));
		if (!shipment.shippingCompany) throw new BadRequestException(this.translations.t("domains.shipping.shipment_company_not_found"));

		const provider = this.getProvider(shipment.shippingCompany.code);
		const integ = await this.getOrCreateIntegration(adminId, shipment.shippingCompany.id);
		if (!integ.isActive) throw new BadRequestException(this.translations.t("domains.shipping.integration_disabled"));

		const accountId = integ?.credentials?.accountId ? String(integ?.credentials?.accountId).trim() : (integ?.credentials?.accountId || undefined)
		const apiKey = integ?.credentials?.apiKey;

		if (!apiKey) throw new BadRequestException(this.translations.t("domains.shipping.credentials_not_configured"));
		const { unifiedStatus, providerShipmentId, rawState } = await provider.getShipmentStatus(apiKey, shipment.trackingNumber, accountId);
		return {
			ok: true,
			shipmentId: shipment.id,
			trackingNumber: shipment.trackingNumber,
			status: unifiedStatus,
			rawState: rawState,
			providerShipmentId
		};
	}
	async getCompanyDistribution(me: any) {
		const adminId = tenantId(me);

		// Step 1: Get all active shipping integrations
		const shippingResponse = await this.activeIntegrations(me);

		// Step 2: Get all company data with counts (including null company)
		const rows = await this.ordersRepo
			.createQueryBuilder('order')
			.leftJoin('order.shippingCompany', 'company')
			.leftJoin('order.status', 'status')
			.leftJoinAndSelect(
				"order.shipments",
				"shipment",
				`shipment.id = (SELECT s.id FROM shipments s WHERE s."trackingNumber" = "order"."trackingNumber" ORDER BY s."created_at" DESC LIMIT 1)`
			)

			.select('company.id', 'companyId')
			.addSelect('company.name', 'companyName')
			.addSelect('COUNT(order.id)', 'count')
			.where('order.adminId = :adminId', { adminId })
			.andWhere('status.code IN (:...included)', {
				included: [OrderStatus.DISTRIBUTED, OrderStatus.PRINTED, OrderStatus.PREPARING, OrderStatus.READY]
			})
			.andWhere("shipment.status IN (:...status)", {
				status: [ShipmentStatus.PENDING_ACTION, ShipmentStatus.PREPARING, ShipmentStatus.READY_TO_SHIP],
			})
			.groupBy('company.id')
			.addGroupBy('company.name')
			.getRawMany();

		// Create a map to quickly look up order count and name by company ID
		const companyDataMap = new Map<string | null, { count: number; name: string | null }>();
		rows.forEach((row) => {
			companyDataMap.set(row.companyId ?? null, {
				count: Number(row.count) || 0,
				name: row.companyName ?? null,
			});
		});

		// Set to track which companies we've already added (for deduplication)
		const addedCompanyIds = new Set<string | null>();

		// Start with all active shipping companies
		const result = shippingResponse.integrations.map((company) => {
			const companyId = company.providerId ?? null;
			addedCompanyIds.add(companyId);
			const data = companyDataMap.get(companyId);
			return {
				companyId: companyId,
				companyName: company.name ?? null,
				count: data?.count || 0,
			};
		});

		// Add companies from query results not already in the list
		rows.forEach((row) => {
			const companyId = row.companyId ?? null;
			if (!addedCompanyIds.has(companyId)) {
				addedCompanyIds.add(companyId);
				const data = companyDataMap.get(companyId);
				result.push({
					companyId: companyId,
					companyName: companyId ? (data?.name ?? null) : "None",
					count: data?.count || 0,
				});
			}
		});

		// Ensure "None" entry is present
		if (!addedCompanyIds.has(null)) {
			addedCompanyIds.add(null);
			result.push({
				companyId: null,
				companyName: "None",
				count: 0,
			});
		}

		return result;
	}


	async getShipmentLifecycleStats(me: any) {
		const adminId = tenantId(me);

		// Helper for distributed counts (assigned to active integrations and not finished)
		const getDistributedBaseQuery = () =>
			this.ordersRepo.createQueryBuilder('order')
				.innerJoin('order.status', 'status')
				.leftJoin('shipping_integrations', 'integ', 'integ.shippingCompanyId = order.shippingCompanyId AND integ.adminId = :adminId AND integ.isActive = true', { adminId })
				.leftJoinAndSelect(
					"order.shipments", // افترضنا وجود علاقة (Relation) باسم shipments في Entity الطلب
					"shipment",
					`shipment.id = (SELECT s.id FROM shipments s WHERE s."trackingNumber" = "order"."trackingNumber" ORDER BY s."created_at" DESC LIMIT 1)`
				)
				.where('order.adminId = :adminId', { adminId })
				.andWhere('status.code IN (:...included)', {
					included: [OrderStatus.DISTRIBUTED, OrderStatus.PRINTED, OrderStatus.PREPARING, OrderStatus.READY]
				})
				.andWhere("shipment.status IN (:...status)", {
					status: [ShipmentStatus.PENDING_ACTION, ShipmentStatus.PREPARING, ShipmentStatus.READY_TO_SHIP],
				})


		// Run all three counts in parallel
		const [confirmed, distributed, distributedNotPrinted] = await Promise.all([
			// 1. Total Confirmed (Pending Assignment)
			this.ordersRepo.count({
				where: {
					adminId,
					status: { code: OrderStatus.CONFIRMED }
				}
			}),

			// 2. Total Distributed (Assigned to active companies and not finished)
			getDistributedBaseQuery().getCount(),

			// 3. Distributed but Label NOT printed (طباعة البوالص)
			getDistributedBaseQuery()
				.andWhere('order.labelPrinted IS NULL')
				.getCount()
		]);

		return {
			confirmed,
			distributed,
			distributedNotPrinted
		};
	}

	// -----------------------
	// Webhook setup helpers (NEW)
	// -----------------------
	private buildPublicWebhookUrl(provider: string) {
		const base = process.env.BACKEND_URL || 'http://localhost:3000';
		return `${base.replace(/\/$/, '')}/shipping/webhooks/${provider}`;
	}

	private generateSecret() {
		return crypto.randomBytes(24).toString('hex');
	}

	async getWebhookSetup(adminId: string, provider: string) {
		const company = await this.getCompanyByProviderForAdmin(adminId, provider);
		const integ = await this.getOrCreateIntegration(adminId, company.id);

		const headerName = (integ.credentials?.webhookHeaderName || 'Authorization').trim();
		let secret = integ.credentials?.webhookSecret;

		if (!secret) {
			secret = this.generateSecret();
			integ.credentials = { ...(integ.credentials || {}), webhookHeaderName: headerName, webhookSecret: secret };
			await this.integrationsRepo.save(integ);
		}

		return {
			ok: true,
			provider,
			webhookUrl: this.buildPublicWebhookUrl(provider),
			headerName,
			headerValue: secret,
		};
	}

	async rotateWebhookSecret(adminId: string, provider: string) {
		const company = await this.getCompanyByProviderForAdmin(adminId, provider);
		const integ = await this.getOrCreateIntegration(adminId, company.id);

		const headerName = (integ.credentials?.webhookHeaderName || 'Authorization').trim();
		const secret = this.generateSecret();

		integ.credentials = { ...(integ.credentials || {}), webhookHeaderName: headerName, webhookSecret: secret };
		await this.integrationsRepo.save(integ);

		return {
			ok: true,
			provider,
			webhookUrl: this.buildPublicWebhookUrl(provider),
			headerName,
			headerValue: secret,
		};
	}

	// -----------------------
	// Webhook processing (UPDATED multi-tenant auth)
	// -----------------------
	async handleWebhook(provider: string, body: any, headers?: Record<string, any>) {
		try {
			const p = this.getProvider(provider);
			const mapped = p.mapWebhookToUnified(body);

			const shipment = await this.shipmentsRepo.findOne({
				where: mapped.providerShipmentId
					? { providerShipmentId: mapped.providerShipmentId }
					: mapped.trackingNumber
						? { trackingNumber: mapped.trackingNumber }
						: ({} as any),

				relations: ['order', 'order.items']
			});

			if (!shipment) return { ok: true, ignored: true, reason: 'shipment_not_found' };


			// Validate header per shipment.adminId + provider integration
			const company = await this.companiesRepo.findOne({ where: { code: provider } });
			if (!company) return { ok: true, ignored: true, reason: 'company_not_found' };

			const integ = await this.integrationsRepo.findOne({ where: { adminId: shipment.adminId, shippingCompanyId: company.id } });

			// If secret exists, require it
			const savedSecret = integ?.credentials?.webhookSecret;
			const customHeaderName = integ?.credentials?.webhookHeaderName; // <--- Pull from DB

			if (savedSecret) {
				// Pass the custom header name to the provider
				const isAuthed = p.verifyWebhookAuth(headers, body, savedSecret, customHeaderName);
				if (!isAuthed) {
					return { ok: true, ignored: true, reason: 'auth_failed' };
				}
			}
			// تشغيل كل شيء داخل Transaction واحدة
			await this.dataSource.transaction(async (manager) => {
				const s = await manager.findOne(ShipmentEntity, {
					where: { id: shipment.id }
				});
				if (!s) return;
				await this.applyMappedUnifiedStatusInTransaction(manager, s as any, mapped, {
					eventSource: provider,
					payload: body,
				});
			});

			return { ok: true };
		} catch (e) {
			console.log(e)
		}
	}

	private async generateUniqueManualTrackingNumber(adminId: string, manager?: EntityManager): Promise<string> {
		const shipRepo = manager ? manager.getRepository(ShipmentEntity) : this.shipmentsRepo;
		const orderRepo = manager ? manager.getRepository(OrderEntity) : this.ordersRepo;
		for (let attempt = 0; attempt < 20; attempt++) {
			const trackingNumber = `MNL${generateRandomAlphanumeric(7)}`;
			const [dupShip, dupOrder] = await Promise.all([
				shipRepo.findOne({ where: { adminId, trackingNumber } }),
				orderRepo.findOne({ where: { adminId, trackingNumber } }),
			]);
			if (!dupShip && !dupOrder) return trackingNumber;
		}
		throw new BadRequestException(this.translations.t("domains.shipping.could_not_allocate_unique_manual_tracking_number"));
	}

	async cancelManualShipment(me: any, shipmentId: string) {
		const adminId = tenantId(me);
		return this.dataSource.transaction(async (manager) => {
			const shipment = await manager.findOne(ShipmentEntity, {
				where: { id: shipmentId, adminId },
				relations: ['order', 'order.items', 'shippingCompany'],
			});
			if (!shipment) throw new NotFoundException(this.translations.t("domains.shipping.shipment_not_found"));
			if (shipment.status === ShipmentStatus.CANCELLED) {
				return { ok: true, message: this.translations.t("domains.shipping.already_cancelled"), shipmentId: shipment.id };
			}

			shipment.unifiedStatus = UnifiedShippingStatus.CANCELLED;
			shipment.status = ShipmentStatus.CANCELLED;
			for (const item of shipment.order.items ?? []) {
				if (!item.variantId) continue;
				await manager.increment(ProductVariantEntity, { id: item.variantId, adminId }, 'stockOnHand', item.quantity);
			}
			await manager.save(shipment);
			return { ok: true, shipmentId: shipment.id, message: this.translations.t("domains.shipping.manual_shipment_cancelled") };
		});
	}

	private async applyMappedUnifiedStatusInTransaction(
		manager: EntityManager,
		shipment: ShipmentEntity & { order: OrderEntity & { items: OrderItemEntity[] } },
		mapped: ProviderWebhookResult,
		eventMeta: { eventSource: string; payload: any },
	): Promise<void> {

		//get order to also update its status with shipment;
		const order = await this.ordersRepo.findOne({
			where: { id: shipment.orderId },
			relations: ['status']
		});

		const oldStatusId = order.statusId;
		const oldShipmentStatus = shipment.status;
		let statusChanged = false;

		const returnStock = async () => {
			const itemsToRestock = (order.items ?? []).filter((item) => item.stockDeducted && item.variantId);
			if (itemsToRestock.length > 0) {
				const restockMap = new Map<string, number>();
				itemsToRestock.forEach((item) => {
					const current = restockMap.get(item.variantId) || 0;
					restockMap.set(item.variantId, current + item.quantity);
				});
				const restockUpdates = Array.from(restockMap.entries()).map(([id, qty]) =>
					manager
						.createQueryBuilder()
						.update(ProductVariantEntity)
						.set({ stockOnHand: () => `"stockOnHand" + ${qty}` })
						.where('id = :id AND adminId = :adminId', { id, adminId: shipment.adminId })
						.execute(),
				);
				const itemsUpdate = manager
					.createQueryBuilder()
					.update(OrderItemEntity)
					.set({ stockDeducted: false })
					.where('id IN (:...ids)', { ids: itemsToRestock.map((i) => i.id) })
					.execute();
				await Promise.all([...restockUpdates, itemsUpdate]);
			}
		}
		shipment.rawStatus = mapped.rawState;
		if (mapped.unifiedStatus === UnifiedShippingStatus.CANCELLED && shipment.unifiedStatus !== UnifiedShippingStatus.CANCELLED) {
			shipment.unifiedStatus = UnifiedShippingStatus.CANCELLED;
			shipment.status = ShipmentStatus.CANCELLED;
			const cancelledStatus = await manager.findOne(OrderStatusEntity, { where: { code: OrderStatus.CANCELLED } });
			if (cancelledStatus) {
				order.statusId = cancelledStatus.id;
				order.status = cancelledStatus;
				statusChanged = true;
			}
			await manager.save(order);
			await returnStock();

			await this.notificationService.create({
				userId: shipment.adminId,
				type: NotificationType.SHIPMENT_CANCELLED,
				title: await this.requestTranslations.tAsync("domains.shipping.shipment_cancelled_title", shipment.adminId),
				message: await this.requestTranslations.tAsync("domains.shipping.shipment_cancelled_message", shipment.adminId, {
					args: {
						orderNumber: order.orderNumber,
					},
				}),
				relatedEntityType: "order",
				relatedEntityId: String(order.id),
			});
		} else {
			shipment.unifiedStatus = mapped.unifiedStatus;
			const newStatus = await this.mapUnifiedToLegacy(mapped.unifiedStatus);
			if (newStatus) {
				shipment.status = newStatus;
			}
		}

		if (mapped.unifiedStatus === UnifiedShippingStatus.DELIVERED) {
			const deliveredStatus = await manager.findOne(OrderStatusEntity, { where: { code: OrderStatus.DELIVERED } });
			if (deliveredStatus) {
				order.statusId = deliveredStatus.id;
				order.status = deliveredStatus;
				order.deliveredAt = new Date();
				statusChanged = true;
			}
			await manager.save(order);
			await this.ordersService.deductStockForOrder(manager, order?.id, shipment?.adminId, { skipValidation: true });

			await this.notificationService.create({
				userId: shipment.adminId,
				type: NotificationType.SHIPMENT_DELIVERED,
				title: await this.requestTranslations.tAsync("domains.shipping.shipment_delivered_title", shipment.adminId),
				message: await this.requestTranslations.tAsync("domains.shipping.shipment_delivered_message", shipment.adminId, {
					args: {
						orderNumber: order.orderNumber,
					},
				}),
				relatedEntityType: "order",
				relatedEntityId: String(order.id),
			});
		} else if (
			mapped.unifiedStatus === UnifiedShippingStatus.EXCEPTION ||
			mapped.unifiedStatus === UnifiedShippingStatus.TERMINATED
		) {
			const failedStatus = await manager.findOne(OrderStatusEntity, { where: { code: OrderStatus.FAILED_DELIVERY } });
			if (failedStatus) {
				order.statusId = failedStatus.id;
				order.status = failedStatus;
				statusChanged = true;
			}
			await manager.save(order);
			await returnStock();

			await this.notificationService.create({
				userId: shipment.adminId,
				type: NotificationType.SHIPMENT_FAILED,
				title: await this.requestTranslations.tAsync("domains.shipping.shipment_failed_title", shipment.adminId),
				message: await this.requestTranslations.tAsync("domains.shipping.shipment_failed_message", shipment.adminId, {
					args: {
						orderNumber: order.orderNumber,
						status: mapped.unifiedStatus,
					},
				}),
				relatedEntityType: "order",
				relatedEntityId: String(order.id),
			});
		}

		if (statusChanged && oldStatusId !== order.statusId) {
			await this.ordersService.logStatusChange({
				adminId: shipment.adminId,
				orderId: order.id,
				fromStatusId: oldStatusId,
				toStatusId: order.statusId,
				notes: await this.requestTranslations.tAsync("domains.shipping.automated_status_update_from_provider", shipment.adminId, {
					args: {
						eventSource: eventMeta.eventSource,
					},
				}),
				manager,
			});
		}
		
		await manager.save(shipment);
		await manager.save(
			manager.create(ShipmentEventEntity, {
				shipmentId: shipment.id,
				source: eventMeta.eventSource as any,
				eventType: 'status_changed',
				payload: eventMeta.payload,
			}),
		);

		// Log to external shipment logs
		await manager.save(
			manager.create(ExternalShipmentLogEntity, {
				shipmentId: shipment.id,
				orderId: shipment.orderId,
				adminId: shipment.adminId,
				notes: mapped.notes,
				rawState: eventMeta.payload,
				rawStatus: mapped.rawState,
				unifiedStatus: mapped.unifiedStatus,
			})
		);
	}

	async updateShipmentStatusManually(me: any, shipmentId: string, dto: ManualUpdateShipmentStatusDto) {
		const adminId = tenantId(me);
		const shipment = await this.shipmentsRepo.findOne({
			where: { id: shipmentId, adminId },
			relations: ['shippingCompany'],
		});
		if (!shipment) throw new NotFoundException('Shipment not found');
		if (shipment.unifiedStatus === UnifiedShippingStatus.DELIVERED) {
			throw new BadRequestException('Cannot change shipment status after it has been delivered.');
		}
		if (dto.status === shipment.unifiedStatus) {
			return {
				ok: true,
				skipped: true,
				shipment: { id: shipment.id, unifiedStatus: shipment.unifiedStatus, status: shipment.status, trackingNumber: shipment.trackingNumber },
			};
		}
		await this.dataSource.transaction(async (manager) => {
			const s = await manager.findOne(ShipmentEntity, {
				where: { id: shipmentId, adminId }
			});
			if (!s) throw new NotFoundException('Shipment not found');
			if (s.unifiedStatus === UnifiedShippingStatus.DELIVERED) {
				throw new BadRequestException('Cannot change shipment status after it has been delivered.');
			}
			await this.applyMappedUnifiedStatusInTransaction(manager, s as any, { unifiedStatus: dto.status }, {
				eventSource: 'system',
				payload: { manual: true, requestedStatus: dto.status },
			});
		});
		const refreshed = await this.shipmentsRepo.findOne({
			where: { id: shipmentId, adminId },
			relations: ['order', 'order.status'],
		});
		return {
			ok: true,
			shipment: refreshed
				? {
					id: refreshed.id,
					unifiedStatus: refreshed.unifiedStatus,
					status: refreshed.status,
					trackingNumber: refreshed.trackingNumber,
				}
				: null,
			order: refreshed?.order
				? { id: refreshed.order.id, status: refreshed.order.status, deliveredAt: refreshed.order.deliveredAt }
				: null,
		};
	}


	private mapUnifiedToLegacy(u: UnifiedShippingStatus): ShipmentStatus {
		// if (u === UnifiedShippingStatus.NEW) return ShipmentStatus.CREATED;
		if (u === UnifiedShippingStatus.DELIVERED) return ShipmentStatus.DELIVERED;
		if (u === UnifiedShippingStatus.CANCELLED) return ShipmentStatus.CANCELLED;

		if ([UnifiedShippingStatus.EXCEPTION, UnifiedShippingStatus.LOST, UnifiedShippingStatus.DAMAGED, UnifiedShippingStatus.TERMINATED].includes(u)) {
			return ShipmentStatus.FAILED;
		}

		// if ([UnifiedShippingStatus.IN_TRANSIT, UnifiedShippingStatus.PICKED_UP, UnifiedShippingStatus.IN_PROGRESS].includes(u)) {
		// 	return ShipmentStatus.IN_TRANSIT;
		// }

		// if (u === UnifiedShippingStatus.RETURNED) return ShipmentStatus.RETURNED;
		// if ([UnifiedShippingStatus.ON_HOLD, UnifiedShippingStatus.ACTION_REQUIRED].includes(u)) return ShipmentStatus.ON_HOLD;
		// if (u === UnifiedShippingStatus.ARCHIVED) return ShipmentStatus.ARCHIVED;

		// return ShipmentStatus.SUBMITTED;
		return null;
	}
}
