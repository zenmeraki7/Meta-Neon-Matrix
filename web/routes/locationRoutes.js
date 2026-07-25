import express from "express";
import {
  handleControllerError,
  requireShopifySession,
} from "../controllers/controllerUtils.js";
import { LocationService } from "../services/locationService/locationService.js";

const router = express.Router();
const locationService = new LocationService();

router.get("/get-all", async (req, res) => {
  try {
    const session = requireShopifySession(res);
    const result = await locationService.fetchLocations(session, req);
    return res.status(200).json(result);
  } catch (error) {
    return handleControllerError(res, error, "LOCATION_FETCH_FAILED");
  }
});

export default router;
