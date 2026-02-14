import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

@Injectable()
export class EncryptionService {
    private readonly algorithm = 'aes-256-gcm';
    private readonly masterKey = process.env.MASTER_ENCRYPTION_KEY;

    async encrypt(data: string): Promise<{ ciphertext: string; iv: string; tag: string }> {
        if (this.masterKey.length !== 32) {
            throw new InternalServerErrorException('MASTER_ENCRYPTION_KEY must be 32 characters.');
        }

        const iv = randomBytes(16); // Unique IV for every encryption
        const cipher = createCipheriv(this.algorithm, Buffer.from(this.masterKey), iv);

        let ciphertext = cipher.update(data, 'utf8', 'hex');
        ciphertext += cipher.final('hex');

        // The "tag" is the Auth Tag provided by GCM mode to prevent tampering
        const tag = cipher.getAuthTag().toString('hex');

        return {
            ciphertext,
            iv: iv.toString('hex'),
            tag,
        };
    }

    async decrypt(ciphertext: string, iv: string, tag: string): Promise<string> {
        const decipher = createDecipheriv(
            this.algorithm,
            Buffer.from(this.masterKey),
            Buffer.from(iv, 'hex'),
        );

        decipher.setAuthTag(Buffer.from(tag, 'hex'));

        let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    }
}