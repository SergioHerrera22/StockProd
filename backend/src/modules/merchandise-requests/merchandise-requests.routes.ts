import { Router } from 'express';
import { z } from 'zod';
import { authRequired, requirePerm } from '../../middleware/auth';
import { asyncH } from '../../middleware/errorHandler';
import { idempotent } from '../../middleware/idempotency';
import { pathId, strParam } from '../../lib/pagination';
import { query } from '../../db/pool';
import { createMerchandiseRequest, getMerchandiseRequest, listMerchandiseRequests, setMerchandiseRequestStatus } from './merchandise-requests.service';
const router=Router(); router.use(authRequired);
const itemsSchema=z.array(z.object({productId:z.number().int().positive(),quantity:z.number().min(3)})).min(1).max(300);
router.get('/products',requirePerm('merchandise_requests.use'),asyncH(async(req,res)=>{
 const term=strParam(req.query.q)?.trim(); if(!term || term.length<2) return res.json({products:[]});
 const pattern='%' + term.replace(/[\\%_]/g, '\\\\$&') + '%';
 const result=await query(`SELECT id,code,barcode,name,brand,unit FROM products
  WHERE is_active=true AND (code ILIKE $1 OR barcode ILIKE $1 OR name ILIKE $1 OR brand ILIKE $1)
  ORDER BY CASE WHEN code=$2 OR barcode=$2 THEN 0 WHEN code ILIKE $1 OR barcode ILIKE $1 THEN 1 ELSE 2 END,name
  LIMIT 25`,[pattern,term]);
 res.json({products:result.rows});
}));
router.get('/',requirePerm('merchandise_requests.use'),asyncH(async(req,res)=>res.json({requests:await listMerchandiseRequests(req.user!,strParam(req.query.status))})));
router.get('/:id',requirePerm('merchandise_requests.use'),asyncH(async(req,res)=>res.json({request:await getMerchandiseRequest(req.user!,pathId(req.params.id))})));
router.post('/',requirePerm('merchandise_requests.use'),idempotent(asyncH(async(req,res)=>{const d=z.object({items:itemsSchema,notes:z.string().max(1000).optional()}).parse(req.body);res.status(201).json(await createMerchandiseRequest(req.user!,d.items,d.notes,req.ip));})));
router.post('/:id/seen',requirePerm('merchandise_requests.manage'),asyncH(async(req,res)=>res.json(await setMerchandiseRequestStatus(req.user!,pathId(req.params.id),'VISTO',undefined,req.ip))));
router.post('/:id/preparing',requirePerm('merchandise_requests.manage'),asyncH(async(req,res)=>res.json(await setMerchandiseRequestStatus(req.user!,pathId(req.params.id),'EN_PREPARACION',undefined,req.ip))));
router.post('/:id/attended',requirePerm('merchandise_requests.manage'),asyncH(async(req,res)=>res.json(await setMerchandiseRequestStatus(req.user!,pathId(req.params.id),'ATENDIDO',undefined,req.ip))));
router.post('/:id/reject',requirePerm('merchandise_requests.manage'),asyncH(async(req,res)=>{const d=z.object({reason:z.string().min(5).max(255)}).parse(req.body);res.json(await setMerchandiseRequestStatus(req.user!,pathId(req.params.id),'RECHAZADO',d.reason,req.ip));}));
export default router;
