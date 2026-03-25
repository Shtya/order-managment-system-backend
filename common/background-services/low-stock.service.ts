import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { ProductVariantEntity } from 'entities/sku.entity';
import { User } from 'entities/user.entity';
import { NotificationService } from 'src/notifications/notification.service';
import { NotificationType } from 'entities/notifications.entity'; // Adjust import path as needed
import { Repository } from 'typeorm';

@Injectable()
export class LowStockService {
  private readonly logger = new Logger(LowStockService.name);

  // Define what "low stock" means. You can also move this to an environment variable or settings table.
  private readonly LOW_STOCK_THRESHOLD = 5;

  constructor(
    @InjectRepository(ProductVariantEntity)
    private readonly productVariantRepo: Repository<ProductVariantEntity>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly notificationService: NotificationService,
  ) { }

  // Runs every 24 hours at 2:00 AM
  @Cron('0 0 2 * * *')
  async handleLowStock() {
    this.logger.log('Checking for low stock variants...');

    try {
      // 1. Fetch all variants where available stock (on hand - reserved) is below the threshold
      // We join the product to potentially use its name in the notification
      const lowStockVariants = await this.productVariantRepo
        .createQueryBuilder('variant')
        .leftJoinAndSelect('variant.product', 'product')
        .where('variant.stockOnHand - variant.reserved <= :threshold', {
          threshold: this.LOW_STOCK_THRESHOLD,
        })
        .getMany();

      if (lowStockVariants.length === 0) {
        this.logger.log('No low stock items found.');
        return;
      }

      // 2. Group variants by adminId to avoid spamming the user with multiple notifications
      const groupedByAdmin = lowStockVariants.reduce((acc, variant) => {
        if (!acc[variant.adminId]) acc[variant.adminId] = [];
        acc[variant.adminId].push(variant);
        return acc;
      }, {} as Record<string, ProductVariantEntity[]>);

      // 3. Process and send notifications
      for (const [adminId, variants] of Object.entries(groupedByAdmin)) {


        // Create a summary message
        const message = variants.length === 1
          ? `Product "${variants[0].product?.name || variants[0].sku}" is running low on stock.`
          : `You have ${variants.length} product variants running low on stock. Please check your inventory.`;

        // Send the notification using your standard method
        await this.notificationService.create({
          userId: Number(adminId),
          type: NotificationType.LOW_STOCK_ALERT, // Make sure this enum value exists
          title: 'Low Stock Alert',
          message: message,
          relatedEntityType: 'product',
          relatedEntityId: variants.length === 1 ? variants[0].productId.toString() : undefined,
        });
      }

      this.logger.log(`Low stock check completed. Alerted ${Object.keys(groupedByAdmin).length} admins.`);
    } catch (error) {
      this.logger.error('Error checking for low stock', error);
    }
  }
}