import express from "express";

const router = express.Router();

router.use((_req, res) =>
  res.status(404).json({
    error: "Intelligence routes are not configured.",
    code: "INTELLIGENCE_ROUTE_NOT_CONFIGURED",
  }),
);

export default router;
