import { Injectable, NestMiddleware } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { AuthGuard } from "@nestjs/passport";
import { SystemRole } from "entities/user.entity";
import { NextFunction,  Response } from "express";
@Injectable()
export class BullBoardAuthMiddleware implements NestMiddleware {
  constructor() { }

  async use(req: any, res: Response, next: NextFunction) {
      const guard = new (AuthGuard('jwt'))(); 
      
      await guard.canActivate({
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      } as any);

    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({
          message: 'Unauthorized'
        });
      }

      const isSuperAdmin = user.role.name === SystemRole.SUPER_ADMIN;
      if (!isSuperAdmin) {
        return res.status(403).json({ message: 'Forbidden: Admins only' });
      }

      next();
    } catch {
      // Token expired or invalid — clear the bad cookie
      res.clearCookie('access_token');
      return res.status(401).json({
        message: 'Token expired or invalid',
      });
    }
  }
}