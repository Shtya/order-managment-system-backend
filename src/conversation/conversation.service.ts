import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { ConversationEntity, ConversationStatus } from 'entities/whatsapp.entity';
import { CustomerEntity } from 'entities/customers.entity';
import { CreateConversationDto } from 'dto/whatsapp.dto';
import { normalizeEgyptianPhoneNumber } from 'common/whatsapp';
import { CustomerService } from '../customer/customer.service';
import { AppGateway } from 'common/app.gateway';

@Injectable()
export class ConversationService {
  constructor(
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    private readonly customerService: CustomerService,
    private readonly appGateway: AppGateway,
  ) { }

  async getOrCreateConversation(me: any, payload: CreateConversationDto) {
    const adminId = me.adminId || me.id;
    if (!adminId) throw new BadRequestException('Missing adminId');

    const customer = await this.customerService.getOrCreateCustomer(me, payload);

    let conversation = await this.conversationRepo.findOne({
      where: { customerId: customer.id, adminId },
    });

    if (!conversation) {
      conversation = this.conversationRepo.create({
        adminId,
        customerId: customer.id,
        status: ConversationStatus.OPEN,
      });
      conversation = await this.conversationRepo.save(conversation);

      // Emit new conversation notification
      this.appGateway.emitNewConversation(adminId, conversation);
    }

    return conversation;
  }

  async save(conversation: ConversationEntity) {
    const saved = await this.conversationRepo.save(conversation);
    // Emit update notification
    if (saved.adminId) {
      this.appGateway.emitUpdateConversation(saved.adminId, saved);
    }
    return saved;
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

    const qb = this.conversationRepo
      .createQueryBuilder('conversation')
      .leftJoinAndSelect('conversation.customer', 'customer')
      .leftJoinAndSelect('conversation.lastMessage', 'lastMessage')
      .where('conversation.adminId = :adminId', { adminId });

    // Filters
    if (q?.status) {
      qb.andWhere('conversation.status = :status', { status: q.status });
    }

    if (q?.customerId) {
      qb.andWhere('conversation.customerId = :customerId', { customerId: q.customerId });
    }

    // Search (by customer name or phone number)
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
      createdAt: 'conversation.createdAt',
      updatedAt: 'conversation.updatedAt',
      lastMessageAt: 'conversation.lastMessageAt',
      status: 'conversation.status',
    };

    if (sortColumns[sortBy]) {
      qb.orderBy(sortColumns[sortBy], sortDir);
    } else {
      qb.orderBy('conversation.createdAt', 'DESC');
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

    const conversation = await this.conversationRepo.findOne({
      where: { id, adminId },
      relations: ['customer', 'messages', 'messages.account', 'lastMessage'],
    });

    if (!conversation) throw new NotFoundException('Conversation not found');

    return conversation;
  }
}
