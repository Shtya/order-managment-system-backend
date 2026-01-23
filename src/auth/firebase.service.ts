import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as admin from 'firebase-admin';

@Injectable()
export class FirebaseService {
  private app: admin.app.App;

  constructor() {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '')
  .replace(/\\n/g, '\n')
  .replace(/\r/g, '')
  .trim();

    if (!projectId || !clientEmail || !privateKey) {
      // ما نكسرش السيرفر لو مش مستخدم جوجل
      // لكن endpoint هيترفض لو اتنادى
      return;
    }

    if (!admin.apps.length) {
      this.app = admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
    } else {
      this.app = admin.app();
    }
  }

  async verifyIdToken(idToken: string) {
    if (!admin.apps.length) {
      throw new UnauthorizedException('Firebase is not configured');
    }

    try {
      return await admin.auth().verifyIdToken(idToken);
    } catch {
      throw new UnauthorizedException('Invalid Google token');
    }
  }
}
