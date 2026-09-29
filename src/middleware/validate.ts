import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

export function validateBody<T extends z.ZodType>(schema: T) {
    return (req: Request, res: Response, next: NextFunction) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            return res.status(400).json({
                message: "Validation failed",
                errors: z.flattenError(result.error).fieldErrors,
            });
        }
        req.body = result.data;
        next();
    };
}
