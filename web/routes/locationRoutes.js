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
    const locations = await locationService.fetchLocations({
      session,
      search: req.query?.search,
    });
    return res.status(200).json({
      success: true,
      total: locations.length,
      data: locations,
    });
  } catch (error) {
    return handleControllerError(res, error, "LOCATION_FETCH_FAILED");
  }
});

export default router;
