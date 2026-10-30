import { Router } from 'express';
import { z } from 'zod';
import { query, withTx } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';
import { pathId } from '../../lib/pagination';
import { writeAudit } from '../../services/audit.service';

const router = Router();
router.use(authRequired);
const schema = z.object({
 name:z.string().trim().min(2).max(180), taxId:z.string().trim().max(20).nullable().optional(),
 contactName:z.string().trim().max(150).nullable().optional(), phone:z.string().trim().max(60).nullable().optional(),
 email:z.string().trim().email().max(180).nullable().or(z.literal('')).optional(),
 address:z.string().trim().max(255).nullable().optional(), notes:z.string().trim().max(2000).nullable().optional(),
 isActive:z.boolean().optional()
});
router.get('/',asyncH(async(req,res)=>{
 const result=await query(`SELECT id,name,tax_id,contact_name,phone,email,address,notes,is_active FROM suppliers
 WHERE ($1::boolean OR is_active) ORDER BY name`,[req.query.includeInactive==='true']);
 res.json({suppliers:result.rows});
}));
router.post('/',requirePerm('suppliers.manage'),asyncH(async(req,res)=>{
 const d=schema.parse(req.body);
 const id=await withTx(async(c)=>{
  const r=await c.query<{id:number}>(`INSERT INTO suppliers(name,tax_id,contact_name,phone,email,address,notes)
   VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[d.name,d.taxId||null,d.contactName||null,d.phone||null,d.email||null,d.address||null,d.notes||null]);
  await writeAudit(c,{userId:req.user!.id,action:'SUPPLIER_CREATE',entity:'supplier',entityId:r.rows[0].id,details:d,ip:req.ip});
  return r.rows[0].id;
 });
 res.status(201).json({id});
}));
router.put('/:id',requirePerm('suppliers.manage'),asyncH(async(req,res)=>{
 const id=pathId(req.params.id),d=schema.partial().parse(req.body);
 if(!Object.keys(d).length) throw ApiError.badRequest('No hay cambios para guardar');
 await withTx(async(c)=>{
  const found=await c.query('SELECT id FROM suppliers WHERE id=$1 FOR UPDATE',[id]);
  if(!found.rows[0]) throw ApiError.notFound('Proveedor no encontrado');
  await c.query(`UPDATE suppliers SET name=COALESCE($1,name),
   tax_id=CASE WHEN $2::boolean THEN $3 ELSE tax_id END,
   contact_name=CASE WHEN $4::boolean THEN $5 ELSE contact_name END,
   phone=CASE WHEN $6::boolean THEN $7 ELSE phone END,
   email=CASE WHEN $8::boolean THEN $9 ELSE email END,
   address=CASE WHEN $10::boolean THEN $11 ELSE address END,
   notes=CASE WHEN $12::boolean THEN $13 ELSE notes END,
   is_active=COALESCE($14,is_active),updated_at=now() WHERE id=$15`,
   [d.name??null,d.taxId!==undefined,d.taxId||null,d.contactName!==undefined,d.contactName||null,
    d.phone!==undefined,d.phone||null,d.email!==undefined,d.email||null,d.address!==undefined,d.address||null,
    d.notes!==undefined,d.notes||null,d.isActive??null,id]);
  await writeAudit(c,{userId:req.user!.id,action:'SUPPLIER_UPDATE',entity:'supplier',entityId:id,details:d,ip:req.ip});
 });
 res.json({ok:true});
}));
export default router;
