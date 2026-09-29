import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().default(1200),
    DATABASE_URL: z.string().min(1),
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    ACCESS_TOKEN_TTL: z.string().default("15m"),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
    CLIENT_URL: z
        .string()
        .default("http://localhost:3000")
        .transform((value) => value.split(",").map((origin) => origin.trim()).filter(Boolean)),
    // Set to the parent domain in production (e.g. ".example.com") so the frontend subdomain can see the session cookies.
    COOKIE_DOMAIN: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error("Invalid environment variables:", z.flattenError(parsed.error).fieldErrors);
    process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
