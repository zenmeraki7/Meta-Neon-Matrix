import express from "express";

const router = express.Router();

router.use((_req, res) =>
  res.status(404).json({
    error: "Referral routes are not configured.",
    code: "REFERRAL_ROUTE_NOT_CONFIGURED",
  }),
);

export default router;
