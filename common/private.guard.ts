import { Observable } from "@apollo/client";
import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";

@Injectable()
export class PrivateGuard implements CanActivate {
  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    // Always return false to make controller inaccessible
    return false;
  }
}