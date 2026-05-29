import express from "express";
import requireSession from "../middleware/requireSession.js";
import productsRouter from "./products.js";
import definitionsRouter from "./metafieldDefinitions.js";
import sessionsRouter from "./sessions.js";
import changesRouter from "./changes.js";
import commitRouter from "./commit.js";
import statusRouter from "./sessionStatus.js";

const router = express.Router();

router.use(requireSession);
router.use("/products", productsRouter);
router.use("/metafield-definitions", definitionsRouter);
router.use("/sessions", sessionsRouter);
router.use("/sessions", changesRouter);
router.use("/sessions", commitRouter);
router.use("/sessions", statusRouter);

export default router;

