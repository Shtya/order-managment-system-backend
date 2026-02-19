import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { Notification } from 'entities/notifications.entity';


@WebSocketGateway({
    cors: {
        origin: process.env.FRONTEND_URL || 'http://localhost:3000',
        credentials: true,
    },
    namespace: '/', // explicit namespace is good practice
})
export class AppGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;


    private onlineUsers = new Set<string>();

    constructor(
        private jwtService: JwtService,
        @InjectRepository(User)
        private userRepository: Repository<User>,
    ) { }

    // --- 1. Connection Handling & Online Status ---
    async handleConnection(socket: Socket) {
        try {
            const token = this.extractToken(socket);
            if (!token) return socket.disconnect();

            const decoded = this.jwtService.verify(token, {
                secret: process.env.JWT_SECRET,
            });

            const user = await this.userRepository.findOne({ where: { id: decoded.sub } });
            if (!user) return socket.disconnect();

            // Store user data on the socket instance for O(1) access later
            socket.data.user = { id: user.id, name: user.name };

            // Join personal room (key for 1-on-1 messaging)
            await socket.join(`user_${user.id}`);

            this.onlineUsers.add(String(user.id));

            console.log(`User ${user.name} (${user.id}) connected.`);

            // ==> REQUIREMENT 2: Broadcast "Green Ball" (Online Status)
            this.broadcastStatus(String(user.id), 'online');

            socket.emit("users:active", { users: Array.from(this.onlineUsers), timestamp: new Date(), });
        } catch (error) {
            console.error('Socket Auth Error:', error.message);
            socket.disconnect();
        }
    }

    // --- 2. Disconnection Handling & Offline Status ---
    handleDisconnect(socket: Socket) {
        const user = socket.data.user;

        if (user) {

            this.onlineUsers.delete(user.id);

            console.log(`User ${user.name} disconnected.`);

            // ==> REQUIREMENT 2: Broadcast "Red/Grey Ball" (Offline Status)
            this.broadcastStatus(user.id, 'offline');
        }
    }


    emitNewNotification(userId: string, notification: Notification) {
        this.server.to(`user_${userId}`).emit("new_notification", notification);
    }

    // --- Helper Methods ---

    private broadcastStatus(userId: string, status: 'online' | 'offline') {
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