import { PoolClient } from 'pg';
import { withTx, query } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { writeAudit } from '../../services/audit.service';
import { AuthUser } from '../../middleware/auth';
import { hasPermission } from '../../lib/permissions';
import { logger } from '../../lib/logger';

type RequestItem = { productId: number; quantity: number };
async function assertWarehouseManager(user: AuthUser, c?: PoolClient) { if(user.role==='ADMIN') return; if(!hasPermission(user.role,'merchandise_requests.manage',user.permissions)) throw ApiError.forbidden(); const rows=c ? await c.query("SELECT id FROM locations WHERE type='DEPOSITO' AND is_active=true") : await query("SELECT id FROM locations WHERE type='DEPOSITO' AND is_active=true"); if(rows.rows.length!==1 || Number(user.locationId)!==Number(rows.rows[0].id)) throw ApiError.forbidden('Solo el encargado del Depósito Central puede gestionar todos los pedidos.'); }
async function centralWarehouseId(c: PoolClient): Promise<number> {
  const r = await c.query<{id:number}>("SELECT id FROM locations WHERE type='DEPOSITO' AND is_active=true ORDER BY id");
  if (r.rows.length !== 1) throw ApiError.conflict('Debe existir exactamente un Depósito Central activo para gestionar pedidos.');
  return r.rows[0].id;
}
export async function listMerchandiseRequests(user: AuthUser, status?: string) {
  const params: unknown[] = [];
  let where = '';
  if (hasPermission(user.role,'merchandise_requests.manage',user.permissions)) {
    await assertWarehouseManager(user);
  }
  const manager = hasPermission(user.role,'merchandise_requests.manage',user.permissions);
  if (!manager) { params.push(user.locationId); where = 'WHERE r.destination_location_id=$1'; }
  if (status) { params.push(status); where += (where ? ' AND ' : 'WHERE ') + 'r.status=$' + params.length; }
  const result = await query(
    `SELECT r.id,r.number,r.status,r.notes,r.created_at,r.destination_location_id,
      dst.name destination_name,u.full_name created_by_name,u.username,
      (SELECT count(*)::int FROM merchandise_request_items i WHERE i.request_id=r.id) item_count
     FROM merchandise_requests r
     JOIN locations dst ON dst.id=r.destination_location_id
     JOIN users u ON u.id=r.created_by
     ${where} ORDER BY r.created_at DESC LIMIT 200`, params);
  return result.rows;
}
export async function getMerchandiseRequest(user: AuthUser, id: number) {
  return withTx(async c => {
    const r=await c.query(`SELECT r.*, src.name origin_name,dst.name destination_name,u.full_name created_by_name
      FROM merchandise_requests r JOIN locations src ON src.id=r.origin_location_id
      JOIN locations dst ON dst.id=r.destination_location_id JOIN users u ON u.id=r.created_by
      WHERE r.id=$1`,[id]);
    const row=r.rows[0]; if(!row) throw ApiError.notFound('Pedido no encontrado');
    const manager=hasPermission(user.role,'merchandise_requests.manage',user.permissions);
    if(manager) await assertWarehouseManager(user,c);
    if(!manager && Number(row.destination_location_id)!==Number(user.locationId)) throw ApiError.forbidden();
    const items=await c.query(`SELECT i.*,p.code,p.barcode,p.name,p.unit FROM merchandise_request_items i
      JOIN products p ON p.id=i.product_id WHERE i.request_id=$1 ORDER BY p.name`,[id]);
    return { ...row, items:items.rows };
  });
}
export async function createMerchandiseRequest(user: AuthUser, items: RequestItem[], notes?: string, ip?:string) {
  if(!user.locationId) throw ApiError.forbidden('Tu usuario no tiene una sucursal asignada.');
  if(user.role==='TRANSPORTE') throw ApiError.forbidden();
  const merged=new Map<number,number>();
  for(const it of items){
    const scaled=it.quantity*1000;
    if(!Number.isInteger(it.productId)||it.productId<=0||!Number.isFinite(it.quantity)||it.quantity<=0||it.quantity>99999999999.999||Math.abs(scaled-Math.round(scaled))>1e-7)
      throw ApiError.badRequest('Cada producto debe tener una cantidad mayor a cero y con un máximo de 3 decimales.');
    const total=(merged.get(it.productId)||0)+it.quantity;
    if(!Number.isFinite(total)||Math.abs(total*1000-Math.round(total*1000))>1e-7)
      throw ApiError.badRequest('La cantidad acumulada supera la precisión permitida.');
    merged.set(it.productId,total);
  }
  if(!merged.size) throw ApiError.badRequest('Agregá al menos un producto.');
  return withTx(async c=>{
    const origin=await centralWarehouseId(c);
    if(origin===user.locationId) throw ApiError.badRequest('El pedido debe realizarse desde una sucursal.');
    const loc=await c.query("SELECT id FROM locations WHERE id=$1 AND type='SUCURSAL' AND is_active=true",[user.locationId]);
    if(!loc.rows[0]) throw ApiError.forbidden('Tu usuario debe tener una sucursal activa asignada.');
    const ids=[...merged.keys()];
    const products=await c.query("SELECT id,name,is_active FROM products WHERE id=ANY($1::int[])",[ids]);
    if(products.rows.length!==ids.length||products.rows.some(p=>!p.is_active)) throw ApiError.badRequest('Hay productos inexistentes o inactivos en el pedido.');
    const ins=await c.query(`INSERT INTO merchandise_requests(number,origin_location_id,destination_location_id,created_by,notes)
      VALUES ('PENDIENTE',$1,$2,$3,$4) RETURNING id`,[origin,user.locationId,user.id,notes?.trim()||null]);
    const id=ins.rows[0].id, number='PED-'+String(id).padStart(7,'0');
    await c.query('UPDATE merchandise_requests SET number=$1 WHERE id=$2',[number,id]);
    await c.query(`INSERT INTO merchandise_request_items(request_id,product_id,quantity_requested)
      SELECT $1,p,q FROM unnest($2::int[],$3::numeric[]) AS x(p,q)`,[id,ids,[...merged.values()]]);
    await writeAudit(c,{userId:user.id,action:'MERCHANDISE_REQUEST_CREATE',entity:'merchandise_request',entityId:id,details:{number,items:ids.length,destination:user.locationId},ip});
    return {id,number,status:'PENDIENTE'};
  });
}
export async function setMerchandiseRequestStatus(user: AuthUser,id:number,status:'VISTO'|'EN_PREPARACION'|'ATENDIDO'|'RECHAZADO',reason?:string,ip?:string){
 let stage='validar encargado de depósito';
 try {
  await assertWarehouseManager(user);
  return await withTx(async c=>{
   stage='bloquear pedido';
   const r=await c.query('SELECT id,status FROM merchandise_requests WHERE id=$1 FOR UPDATE',[id]);
   if(!r.rows[0])throw ApiError.notFound('Pedido no encontrado');
   if(!['PENDIENTE','VISTO','EN_PREPARACION'].includes(r.rows[0].status))throw ApiError.conflict('El pedido ya fue tomado o resuelto.');
   if(status==='RECHAZADO'&&(!reason||reason.trim().length<5))throw ApiError.badRequest('Indicá el motivo del rechazo.');
   stage='actualizar estado del pedido';
   // El parámetro $1 es un ENUM en la asignación; tiparlo explícitamente
   // evita que PostgreSQL lo infiera como text en la condición CASE.
   await c.query("UPDATE merchandise_requests SET status=$1::merchandise_request_status,rejection_reason=$2,handled_by=$3,handled_at=CASE WHEN $1::merchandise_request_status IN ('ATENDIDO'::merchandise_request_status,'RECHAZADO'::merchandise_request_status) THEN now() ELSE handled_at END,updated_at=now() WHERE id=$4",[status,status==='RECHAZADO'?reason!.trim():null,user.id,id]);
   stage='registrar auditoría';
   await writeAudit(c,{userId:user.id,action:'MERCHANDISE_REQUEST_STATUS',entity:'merchandise_request',entityId:id,details:{status,reason},ip});
   return {ok:true,status};
  });
 } catch(err) {
  const e=err as {message?:string;code?:string;constraint?:string;detail?:string};
  logger.error(`No se pudo cambiar el estado del pedido ${id} a ${status}; usuario=${user.id}; etapa=${stage}; code=${e?.code||'N/A'}; constraint=${e?.constraint||'N/A'}; detail=${e?.detail||'N/A'}; error=${e?.message||String(err)}`, err instanceof Error ? err.stack : undefined);
  throw err;
 }
}
