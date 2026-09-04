import { createObserveModule } from "@nestjs/observe";
import * as jwt from "jsonwebtoken";

export const { ObserveModule, ObserveInstrument } = createObserveModule();

export const observeConfig = {
  appKey: process.env.OBSERVE_APP_KEY,
  appSecret: process.env.OBSERVE_APP_SECRET,
  serviceId: process.env.OBSERVE_SERVICE_ID,
  serviceVersion: process.env.OBSERVE_SERVICE_VERSION,

  jobs: {
    setAttributes: (job: any) => ({
      "job.queue": job.queueName,
      "job.name": job.name,
      "job.id": job.id,
    }),
  },

  http: {
    ignore: [
      {
        method: "GET",
        path: /^\/uploads(?:\/|$)/,
      },
    ],

    getUserId: (req: any) => {
      const header = req.headers?.authorization;

      const token =
        typeof header === "string"
          ? header.replace(/^Bearer\s+/i, "")
          : req.query?.token;

      if (!token || typeof token !== "string") {
        return undefined;
      }

      try {
        const payload = jwt.decode(token) as { sub?: string } | null;

        return payload?.sub ? String(payload.sub) : undefined;
      } catch {
        return undefined;
      }
    },

    tags: {
      project: "madar-backend",
      env: process.env.NODE_ENV ?? "development",
    },

    setAttributes: (req: any) => ({
      "user-agent": req.headers["user-agent"],
      "client-ip": req.ip,
      "x-frontend-route": req.headers["x-frontend-route"],
    }),
  },
};