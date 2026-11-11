"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const pool_1 = require("../../db/pool");
const errors_1 = require("../../lib/errors");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const pagination_1 = require("../../lib/pagination");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired);
router.get('/', (0, errorHandler_1.asyncH)(async (_req, res) => {
    const r = await (0, pool_1.query)(`SELECT id, name, description, is_active FROM categories WHERE is_active ORDER BY name`);
    res.json({ categories: r.rows });
}));
router.post('/', (0, auth_1.requirePerm)('categories.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const { name, description } = zod_1.z
        .object({ name: zod_1.z.string().min(2).max(120), description: zod_1.z.string().max(255).optional() })
        .parse(req.body);
    const r = await (0, pool_1.query)(`INSERT INTO categories (name, description) VALUES ($1,$2)
       ON CONFLICT (name) DO UPDATE SET is_active = true RETURNING id`, [name.trim(), description ?? null]);
    res.status(201).json({ id: r.rows[0].id });
}));
router.delete('/:id', (0, auth_1.requirePerm)('categories.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const id = (0, pagination_1.pathId)(req.params.id);
    const used = await (0, pool_1.query)('SELECT id FROM products WHERE category_id = $1 LIMIT 1', [id]);
    if (used.rows[0])
        throw errors_1.ApiError.conflict('Hay productos usando esta categoria');
    await (0, pool_1.query)('UPDATE categories SET is_active = false WHERE id = $1', [id]);
    res.json({ ok: true });
}));
exports.default = router;
