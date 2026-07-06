// remote-image.helper.ts

import {
    BadRequestException,
    Inject,
    Injectable,
    Optional,
} from "@nestjs/common";
import axios from "axios";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

@Injectable()
export class RemoteImageHelper {
    private readonly MAX_SIZE = 10 * 1024 * 1024; // 10MB
    constructor(
        @Inject('PUBLIC_BASE_URL') private readonly publicBaseUrl: string
    ) { }

    async downloadAndSaveImage(url: string) {
        // 📥 1. Check if it's a local path first
        if (url.startsWith('uploads/') || url.startsWith('/uploads/')) {
            const normalizedPath = url.startsWith('/') ? url.slice(1) : url;
            const fullPath = path.join(process.cwd(), normalizedPath);
            if (fs.existsSync(fullPath)) {
                return { url: normalizedPath };
            }
        }

        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new BadRequestException("Invalid image URL or local path");
        }

        if (parsed.protocol !== "https:") {
            throw new BadRequestException("Only HTTPS images are allowed");
        }

        // 📥 2. Download image
        try {
            const response = await axios.get(url, {
                responseType: "arraybuffer",
                timeout: 15000,
                maxContentLength: this.MAX_SIZE,
                validateStatus: (s) => s >= 200 && s < 300,
            });

            const contentType = response.headers["content-type"];
            if (typeof contentType !== "string" || !contentType.startsWith("image/")) {
                throw new Error("Response is not an image");
            }

            const size = Buffer.byteLength(response.data);
            if (size > this.MAX_SIZE) {
                throw new BadRequestException("Image too large");
            }

            // 🧾 3. Generate file name
            const ext = this.getExtension(contentType);
            const fileName = `${Date.now()}-${randomUUID()}.${ext}`;

            // 📁 4. Save file locally
            const uploadDir = path.join(process.cwd(), this.publicBaseUrl);
            await fs.promises.mkdir(uploadDir, { recursive: true });

            const filePath = path.join(uploadDir, fileName);
            await fs.promises.writeFile(filePath, response.data);

            // 🌐 5. Public URL (adjust based on your server)
            const publicUrl = `${this.publicBaseUrl}/${fileName}`;

            return { url: publicUrl };
        } catch (error) {
            throw new BadRequestException(`Failed to download image ${url}`);
        }

    }

    private getExtension(type: string): string {
        switch (type) {
            case "image/png":
                return "png";

            case "image/jpeg":
            case "image/jpg":
                return "jpg";

            case "image/webp":
                return "webp";

            case "image/gif":
                return "gif";

            case "image/svg+xml":
                return "svg";

            case "image/avif":
                return "avif";

            case "image/bmp":
                return "bmp";

            case "image/x-icon":
            case "image/vnd.microsoft.icon":
                return "ico";

            case "image/tiff":
                return "tiff";

            case "image/apng":
                return "apng";

            default:
                return "bin";
        }
    }
}