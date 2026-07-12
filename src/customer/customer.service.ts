import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, EntityManager, Repository } from 'typeorm';
import { CustomerEntity } from 'entities/customers.entity';
import { UpdateCustomerDto } from 'dto/customer.dto';
import { normalizeEgyptianPhoneNumber } from 'common/whatsapp';
import { AppGateway } from 'common/app.gateway';
import { deleteFile } from 'common/healpers';
import { tenantId } from 'src/category/category.service';
import { TranslationService } from 'common/translation.service';

@Injectable()
export class CustomerService {
  constructor(
    @InjectRepository(CustomerEntity)
    private readonly customerRepo: Repository<CustomerEntity>,
    private readonly appGateway: AppGateway,
    private readonly translations: TranslationService,
  ) { }

  async update(me: any, id: string, payload: UpdateCustomerDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    const customer = await this.customerRepo.findOne({
      where: { id, adminId },
    });
    if (!customer) throw new NotFoundException(this.translations.t('domains.customer.not_found'));

    if (payload.phoneNumber) {
      customer.phoneNumber = normalizeEgyptianPhoneNumber(payload.phoneNumber);
    }

    customer.email = payload.email ? payload.email.toLowerCase() : null;

    const oldImage = customer.profilePicture;
    if (payload.profilePicture) {

      customer.profilePicture = payload.profilePicture;

    }

    if (payload.name) {
      customer.name = payload.name.trim();
    }

    customer.notes = payload.notes;


    const saved = await this.customerRepo.save(customer);
    if (oldImage && oldImage !== saved.profilePicture) {
      deleteFile(oldImage);
    }
    return saved;
  }

  async getOrCreateCustomer(me: any, payload: { phoneNumber: string, name?: string, email?: string, profilePicture?: string, notes?: string }, manager?: EntityManager) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    const repo = manager ? manager.getRepository(CustomerEntity) : this.customerRepo;
    const normalizedPhoneNumber = normalizeEgyptianPhoneNumber(payload.phoneNumber);

    let customer = await repo.findOne({
      where: { phoneNumber: normalizedPhoneNumber, adminId },
    });

    if (!customer) {
      customer = repo.create({
        adminId,
        waId: normalizedPhoneNumber,
        phoneNumber: normalizedPhoneNumber,
        name: payload.name || normalizedPhoneNumber,
        email: payload.email,
        profilePicture: payload.profilePicture,
        notes: payload.notes,
      });
      customer = await repo.save(customer);

      // Emit new customer notification
      this.appGateway.emitNewCustomer(adminId, customer);
    }

    return customer;
  }

  async createCustomer(me: any, payload: { phoneNumber: string, name?: string, email?: string, profilePicture?: string, notes?: string }, manager?: EntityManager) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    const repo = manager ? manager.getRepository(CustomerEntity) : this.customerRepo;
    const normalizedPhoneNumber = normalizeEgyptianPhoneNumber(payload.phoneNumber);

    const existing = await repo.findOne({
      where: { phoneNumber: normalizedPhoneNumber, adminId },
    });

    if (existing) {
      throw new ConflictException(this.translations.t('domains.customer.phone_already_exists'));
    }

    const customer = repo.create({
      adminId,
      waId: normalizedPhoneNumber,
      phoneNumber: normalizedPhoneNumber,
      name: payload.name || normalizedPhoneNumber,
      email: payload.email,
      profilePicture: payload.profilePicture,
      notes: payload.notes,
    });
    const saved = await repo.save(customer);

    // Emit new customer notification
    this.appGateway.emitNewCustomer(adminId, saved);

    return saved;
  }

  async findAllPaginated(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    const page = Number(q?.page ?? 1);
    const limit = Number(q?.limit ?? 10);
    const search = String(q?.search ?? '').trim();
    const sortBy = String(q?.sortBy ?? 'createdAt');
    const sortDir: 'ASC' | 'DESC' =
      String(q?.sortDir ?? 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const qb = this.customerRepo
      .createQueryBuilder('customer')
      .where('customer.adminId = :adminId', { adminId });

    // Search (by name or phone number)
    if (search) {
      qb.andWhere(
        new Brackets((sq) => {
          sq.where('customer.name ILIKE :s', { s: `%${search}%` })
            .orWhere('customer.phoneNumber ILIKE :s', { s: `%${search}%` });
        }),
      );
    }

    // Sorting
    const sortColumns: Record<string, string> = {
      createdAt: 'customer.createdAt',
      updatedAt: 'customer.updatedAt',
      name: 'customer.name',
      phoneNumber: 'customer.phoneNumber',
    };

    if (sortColumns[sortBy]) {
      qb.orderBy(sortColumns[sortBy], sortDir);
    } else {
      qb.orderBy('customer.createdAt', 'DESC');
    }

    const total = await qb.getCount();
    const records = await qb.skip((page - 1) * limit).take(limit).getMany();

    return {
      total_records: total,
      current_page: page,
      per_page: limit,
      records,
    };
  }

  async findOne(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    const customer = await this.customerRepo.findOne({
      where: { id, adminId },
      relations: ['conversations'],
    });

    if (!customer) throw new NotFoundException(this.translations.t('domains.customer.not_found'));

    return customer;
  }
}
