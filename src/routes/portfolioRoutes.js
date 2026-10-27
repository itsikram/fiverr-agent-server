import express from 'express';
import {
  listPortfolio,
  createPortfolioItem,
  updatePortfolioItem,
  deletePortfolioItem,
  getPublicPortfolio,
} from '../controllers/portfolioController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /portfolio/public/:username - Public projects (no auth)
 */
router.get('/public/:username', getPublicPortfolio);

/**
 * GET /portfolio - Signed-in user's projects
 */
router.get('/', authenticate, listPortfolio);

/**
 * POST /portfolio - Add a project
 */
router.post('/', authenticate, createPortfolioItem);

/**
 * PUT /portfolio/:id - Update a project
 */
router.put('/:id', authenticate, updatePortfolioItem);

/**
 * DELETE /portfolio/:id - Remove a project
 */
router.delete('/:id', authenticate, deletePortfolioItem);

export default router;
