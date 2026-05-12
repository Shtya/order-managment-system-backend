import { Injectable } from '@nestjs/common';

@Injectable()
export class WhatsappService {
    async exchangeCodeForToken(code: string, state?: string) {
        const params = new URLSearchParams({
            client_id: process.env.META_APP_ID!,
            client_secret: process.env.META_APP_SECRET!,
            redirect_uri: process.env.META_REDIRECT_URI!,
            code,
        });

        const response = await fetch(
            `https://graph.facebook.com/v22.0/oauth/access_token?${params.toString()}`,
            {
                method: 'GET',
            },
        );

        return response.json();
    }
}
