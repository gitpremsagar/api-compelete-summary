import { Router } from "express";
import { z } from "zod";
import { validateBody } from "../middleware/validate.js";

/**
 * Mounted before the admin router's cookie guard. The API calls this on its own loopback address
 * when content changes, so the secret never leaves the machine.
 */
export const adminInternalRouter = Router();

const revalidateSchema = z.object({
    paths: z.array(z.string().max(1024)).min(1).max(20),
});

adminInternalRouter.post("/revalidate-callback", validateBody(revalidateSchema), async (req, res) => {
    // The actual cache invalidation happens in the Next.js route handler at POST /api/admin/revalidate.
    res.json({ ok: true, paths: req.body.paths as string[] });
});
