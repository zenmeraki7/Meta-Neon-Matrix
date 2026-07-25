import express from 'express';
import { addSuggestion } from '../controllers/suggestionController.js';
import { validateBody } from "../middleware/validateQuery.js";
import { validateSession } from "../middleware/validateSession.js";
import { suggestionCreateSchema } from "../validations/suggestionSchema.js";

const router = express.Router();
router.post('/submit', validateSession, validateBody(suggestionCreateSchema), addSuggestion);

export default router;
