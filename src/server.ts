import { env } from "./config/env.js";
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { authRouter } from "./routes/auth.routes.js";
import { adminRouter } from "./routes/admin.routes.js";
import { progressRouter } from "./routes/progress.routes.js";
import { errorHandler } from "./middleware/errorHandler.js";

const app = express();

app.set("trust proxy", 1);
app.use(cors({ origin: ["http://localhost:3000", "https://www.completesummary.com","https://completesummary.com"], credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.get("/", (req, res) => {
    res.send("Hello World");
});

app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
app.use("/api/progress", progressRouter);

app.use(errorHandler);

const port = env.PORT;

app.listen(port, () => {
    console.log(`Server is running on port ${port}\nhttp://localhost:${port}`);
});
