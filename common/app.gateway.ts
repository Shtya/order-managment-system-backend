import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { Notification } from 'entities/notifications.entity';
import { ConversationEntity, WhatsappMessageEntity } from 'entities/whatsapp.entity';
import { CustomerEntity } from 'entities/customers.entity';
import { createClient, RedisClientOptions } from 'redis';
import { ConfigService } from '@nestjs/config';


@WebSocketGateway({
    cors: {
        origin: process.env.FRONTEND_URL || 'http://localhost:3000',
        credentials: true,
    },
    namespace: '/',
})
export class AppGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;

    private redisClient;

    constructor(
        private jwtService: JwtService,
        private configService: ConfigService, // 1. Inject ConfigService
        @InjectRepository(User)
        private userRepository: Repository<User>,
    ) {
        // 2. Reuse the exact same config logic as RedisIoAdapter
        const redisConfig = this.configService.get('redis');
        const redisUrl = `redis${redisConfig.useTls ? 's' : ''}://${redisConfig.host}:${redisConfig.port}`;

        const clientOptions: RedisClientOptions = {
            url: redisUrl,
            username: redisConfig.username,
            password: redisConfig.password,
            database: redisConfig.db,
            socket: redisConfig.tls ? { tls: true } : undefined,
        };

        this.redisClient = createClient(clientOptions);
        this.redisClient.connect();
    }

    async isUserOnline(userId: string): Promise<boolean> {
        const normalizedUserId = String(userId);
        const isOnline = await this.redisClient.sIsMember('online_users', normalizedUserId);
        return Boolean(isOnline);
    }

    // --- 1. Connection Handling ---
    async handleConnection(socket: Socket) {
        try {
            const token = this.extractToken(socket);
            if (!token) return socket.disconnect();

            const decoded = this.jwtService.verify(token, {
                secret: process.env.JWT_SECRET,
            });

            const user = await this.userRepository.findOne({ where: { id: decoded.sub } });
            if (!user) return socket.disconnect();

            const userId = String(user.id);
            socket.data.user = { id: userId, name: user.name };

            // Join personal room for direct 1-on-1 emits across cluster
            await socket.join(`user_${userId}`);

            // FIX 1: Track connection count across ALL PM2 workers
            const activeConnections = await this.redisClient.incr(`user_sockets:${userId}`);
            await this.redisClient.sAdd('online_users', userId);

            console.log(`User ${user.name} connected on PID ${process.pid}. Total tabs open: ${activeConnections}`);

            // Only broadcast "online" on the user's FIRST tab/device connection
            if (activeConnections === 1) {
                this.broadcastStatus(userId, 'online');
            }

            // FIX 2: Fetch global online users list from Redis
            const allOnlineUsers = await this.redisClient.sMembers('online_users');

            socket.emit('users:active', {
                users: allOnlineUsers,
                timestamp: new Date(),
            });
        } catch (error: any) {
            console.error('Socket Auth Error:', error.message);
            socket.disconnect();
        }
    }

    // --- 2. Disconnection Handling ---
    async handleDisconnect(socket: Socket) {
        const user = socket.data.user;

        if (user) {
            const userId = String(user.id);

            // FIX 3: Decrement total connection count across cluster
            const remainingConnections = await this.redisClient.decr(`user_sockets:${userId}`);

            console.log(`User ${user.name} disconnected from PID ${process.pid}. Remaining tabs: ${remainingConnections}`);

            // Only broadcast "offline" when ALL tabs/devices are closed
            if (remainingConnections <= 0) {
                await this.redisClient.del(`user_sockets:${userId}`);
                await this.redisClient.sRem('online_users', userId);

                this.broadcastStatus(userId, 'offline');
            }
        }
    }


    emitStoreSyncStatus(userId: string, payload: { storeId: string; provider: string; status: string, type: "local" | "remote" }) {

        this.server.to(`user_${userId}`).emit("store:sync-status", {
            ...payload,
            type: payload.type || "remote",
            timestamp: new Date(),
        });
    }

    emitWebhookRetryStatus(
        userId: string,
        payload: {
            failureId: string;
            status: string;
            orderId?: string | null;
            message?: string;
            attempts?: number
        }
    ) {
        this.server.to(`user_${userId}`).emit("webhook:retry-status", {
            ...payload,
            timestamp: new Date(),
        });
    }

    emitNewNotification(userId: string, notification: Notification) {
        this.server.to(`user_${userId}`).emit("new_notification", notification);
    }

    emitShipmentStatus(userId: string, payload: {
        orderId: string;
        orderNumber?: string;
        shipmentId?: string;
        status: 'success' | 'failed';
        message?: string;
        trackingNumber?: string;
    }) {
        this.server.to(`user_${userId}`).emit("shipment:status", {
            ...payload,
            timestamp: new Date(),
        });
    }

    emitAutomationRunStatus(userId: string, payload: {
        runId: string;
        automationFlowId: string;
        status: string;
        currentNodeId?: string;
        completedNodeIds?: string[];
        errorMessage?: string;
        executionState?: any;
    }) {
        this.server.to(`user_${userId}`).emit("automation:run-status", {
            ...payload,
            timestamp: new Date(),
        });
    }

    emitWhatsappSignupStatus(userId: string, payload: {
        step: 'EXCHANGING_TOKEN' | 'FETCHING_PHONE_DATA' | 'SUBSCRIBING_APP' | 'REGISTERING_PHONE' | 'CREATING_ACCOUNT' | 'SYNCING_TEMPLATES' | 'COMPLETED' | 'FAILED';
        status: 'in_progress' | 'completed' | 'failed' | 'warning';
        message?: string;
        error?: string;
        accountId?: string;
    }) {
        this.server.to(`user_${userId}`).emit("whatsapp:signup-status", {
            ...payload,
            timestamp: new Date(),
        });
    }

    // --- WhatsApp & Conversation Notifications ---

    async emitNewMessage(userId: string, message: WhatsappMessageEntity) {
        const isOnline = await this.isUserOnline(userId);
        console.log(`[PID ${process.pid}] Emitting whatsapp:message-new to user ${userId} - ${isOnline ? 'ONLINE' : 'OFFLINE'}`);
        this.server.to(`user_${userId}`).emit("whatsapp:message-new", {
            message,
            timestamp: new Date(),
        });
    }

    async emitUpdateMessage(userId: string, message: WhatsappMessageEntity) {
        const isOnline = await this.isUserOnline(userId);

        console.log(`[PID ${process.pid}] Emitting whatsapp:message-updated to user ${userId} - ${isOnline ? 'ONLINE' : 'OFFLINE'}`);
        this.server.to(`user_${userId}`).emit("whatsapp:message-updated", {
            message,
            timestamp: new Date(),
        });
    }

    emitNewConversation(userId: string, conversation: ConversationEntity) {
        this.server.to(`user_${userId}`).emit("whatsapp:conversation-new", {
            conversation,
            timestamp: new Date(),
        });
    }


    emitNewCustomer(userId: string, customer: CustomerEntity) {
        this.server.to(`user_${userId}`).emit("whatsapp:customer-new", {
            customer,
            timestamp: new Date(),
        });
    }

    // --- Helper Methods ---

    private broadcastStatus(userId: string, status: 'online' | 'offline') {
        console.log(`Broadcasting user:status for user ${userId} - status: ${status}`);
        // Emit to everyone connected to the server
        this.server.emit('user:status', {
            userId,
            status,
            timestamp: new Date(),
        });
    }

    private extractToken(socket: Socket): string | null {
        const auth = socket.handshake.auth?.token || socket.handshake.headers?.authorization;
        // If it comes as "Bearer <token>", split it
        if (auth && auth.split(' ')[0] === 'Bearer') {
            return auth.split(' ')[1];
        }
        return auth || null;
    }
}