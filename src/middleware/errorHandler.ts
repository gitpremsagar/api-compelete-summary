import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/httpError.js";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
    if (err instanceof HttpError) {
        return res.status(err.status).json({ message: err.message });
    }
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
}
