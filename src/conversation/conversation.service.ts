import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, Repository } from 'typeorm';
import { ConversationEntity, ConversationStatus } from 'entities/whatsapp.entity';
import { CustomerEntity } from 'entities/customers.entity';
import { CreateConversationDto } from 'dto/whatsapp.dto';
import { normalizeEgyptianPhoneNumber } from 'common/whatsapp';
import { CustomerService } from '../customer/customer.service';
import { AppGateway } from 'common/app.gateway';
import { tenantId } from 'src/category/category.service';
import { TranslationService } from 'common/translation.service';

@Injectable()
export class ConversationService {
  constructor(
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    private readonly customerService: CustomerService,
    private readonly appGateway: AppGateway,
    private readonly dataSource: DataSource,
    private readonly translations: TranslationService,
  ) { }

  async getOrCreateConversation(me: any, payload: CreateConversationDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    return this.dataSource.transaction(async (manager) => {
      const customer = await this.customerService.getOrCreateCustomer(me, payload, manager);

      const repo = manager.getRepository(ConversationEntity);

      let conversation = await repo.findOne({
        where: { customerId: customer.id, adminId },
      });

      if (!conversation) {
        conversation = repo.create({
          adminId,
          customerId: customer.id,
          status: ConversationStatus.OPEN,
        });
        conversation = await repo.save(conversation);

        const finalConversation = await repo.findOne({
          where: { customerId: customer.id, adminId },
          relations: ['customer', 'lastMessage'],
        });
        // Emit new conversation notification
        this.appGateway.emitNewConversation(adminId, finalConversation);
      }

      return conversation;
    });
  }

  async createConversation(me: any, payload: CreateConversationDto) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    return this.dataSource.transaction(async (manager) => {
      const customer = await this.customerService.createCustomer(me, payload, manager);

      const repo = manager.getRepository(ConversationEntity);

      const conversation = repo.create({
        adminId,
        customerId: customer.id,
        status: ConversationStatus.OPEN,
      });
      const savedConversation = await repo.save(conversation);

      const finalConversation = await repo.findOne({
        where: { id: savedConversation.id },
        relations: ['customer', 'lastMessage'],
      });

      // Emit new conversation notification
      this.appGateway.emitNewConversation(adminId, finalConversation);

      return finalConversation;
    });
  }

  async save(conversation: ConversationEntity) {
    const saved = await this.conversationRepo.save(conversation);
    return saved;
  }

  async findAllPaginated(me: any, q?: any) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    const limit = Number(q?.limit ?? 50);
    const search = String(q?.search ?? '').trim();
    const sortBy = String(q?.sortBy ?? 'lastMessageAt'); // Default to lastMessageAt for chat
    const sortDir: 'ASC' | 'DESC' =
      String(q?.sortDir ?? 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // const lastId = q?.lastId;
    const cursor = q?.cursor;

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

    if (q?.unreadOnly === 'true' || q?.unreadOnly === true) {
      qb.andWhere('conversation.unreadCount > 0');
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

    // Cursor Pagination Logic
    const sortColumns: Record<string, string> = {
      createdAt: 'conversation.createdAt',
      updatedAt: 'conversation.updatedAt',
      lastMessageAt: 'conversation.lastMessageAt',
      status: 'conversation.status',
    };

    const sortCol = sortColumns[sortBy] || 'conversation.lastMessageAt';

    if (cursor) {
      const operator = sortDir === "DESC" ? "<" : ">";

      qb.andWhere(
        `(${sortCol}, conversation.id) ${operator} (:cursorValue, :cursorId)`,
        {
          cursorValue: cursor.value,
          cursorId: cursor.id,
        },
      );
    }

    // Always sort by primary column AND id as tie-breaker
    qb.orderBy(sortCol, sortDir);
    qb.addOrderBy('conversation.id', sortDir);

    const recordsWithExtra = await qb.take(limit + 1).getMany();
    const hasMore = recordsWithExtra.length > limit;
    const records = hasMore ? recordsWithExtra.slice(0, limit) : recordsWithExtra;

    return {
      records,
      hasMore,
      limit,
      nextCursor: hasMore ? { "value": records?.[records.length - 1]?.[sortBy], "id": records?.[records.length - 1]?.id } : undefined,
      sortBy,
      sortDir,
    };
  }

  async findOne(me: any, id: string) {
    const adminId = tenantId(me);
    if (!adminId) throw new BadRequestException(this.translations.t('common.missing_admin_id'));

    const conversation = await this.conversationRepo.findOne({
      where: { id, adminId },
      relations: ['customer', 'messages', 'messages.account', 'lastMessage'],
    });

    if (!conversation) throw new NotFoundException(this.translations.t('domains.conversation.not_found'));

    return conversation;
  }
}
