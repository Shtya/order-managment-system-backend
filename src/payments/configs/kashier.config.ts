import { registerAs } from '@nestjs/config';

export default registerAs('kashier', () => {
    const mode = process.env.PAYMENT_MODE || 'test';

    if (mode === 'live') {
        return {
            mode,
            baseUrl: process.env.KASHIER_LIVE_BASE_URL,
            apiKey: process.env.KASHIER_LIVE_API_KEY,
            secretKey: process.env.KASHIER_LIVE_SECRET_KEY,
            merchantId: process.env.KASHIER_LIVE_MERCHANT_ID,
        };
    }

    return {
        mode,
        baseUrl: process.env.KASHIER_TEST_BASE_URL,
        apiKey: process.env.KASHIER_TEST_API_KEY,
        secretKey: process.env.KASHIER_TEST_SECRET_KEY,
        merchantId: process.env.KASHIER_TEST_MERCHANT_ID,
    };
});