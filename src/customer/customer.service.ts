import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { CustomerEntity } from 'entities/customers.entity';
import { UpdateCustomerDto } from 'dto/customer.dto';
import { normalizeEgyptianPhoneNumber } from 'common/whatsapp';
import { AppGateway } from 'common/app.gateway';

@Injectable()
export class CustomerService {
  constructor(
    @InjectRepository(CustomerEntity)
    private readonly customerRepo: Repository<CustomerEntity>,
    private readonly appGateway: AppGateway,
  ) { }

  async update(me: any, id: string, payload: UpdateCustomerDto) {
    const adminId = me.adminId || me.id;
    if (!adminId) throw new BadRequestException('Missing adminId');

    const customer = await this.customerRepo.findOne({
      where: { id, adminId },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    if (payload.phoneNumber) {
      customer.phoneNumber = normalizeEgyptianPhoneNumber(payload.phoneNumber);
    }

    if (payload.email) {
      customer.email = payload.email.toLowerCase();
    }
    if (payload.profilePicture) {
      customer.profilePicture = payload.profilePicture;
    }

    if (payload.name) {
      customer.name = payload.name.trim();
    }

    const saved = await this.customerRepo.save(customer);
    this.appGateway.emitUpdateCustomer(adminId, saved);
    return saved;
  }

  async getOrCreateCustomer(me: any, payload: { phoneNumber: string, name?: string, email?: string, profilePicture?: string }) {
    const adminId = me.adminId || me.id;
    if (!adminId) throw new BadRequestException('Missing adminId');

    const normalizedPhoneNumber = normalizeEgyptianPhoneNumber(payload.phoneNumber);

    let customer = await this.customerRepo.findOne({
      where: { phoneNumber: normalizedPhoneNumber, adminId },
    });

    if (!customer) {
      customer = this.customerRepo.create({
        adminId,
        waId: normalizedPhoneNumber,
        phoneNumber: normalizedPhoneNumber,
        name: payload.name || normalizedPhoneNumber,
        email: payload.email,
        profilePicture: payload.profilePicture,
      });
      customer = await this.customerRepo.save(customer);

      // Emit new customer notification
      this.appGateway.emitNewCustomer(adminId, customer);
    }

    return customer;
  }

  async findAllPaginated(me: any, q?: any) {
    const adminId = me.adminId || me.id;
    if (!adminId) throw new BadRequestException('Missing adminId');

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
    const adminId = me.adminId || me.id;
    if (!adminId) throw new BadRequestException('Missing adminId');

    const customer = await this.customerRepo.findOne({
      where: { id, adminId },
      relations: ['conversations'],
    });

    if (!customer) throw new NotFoundException('Customer not found');

    return customer;
  }
}
