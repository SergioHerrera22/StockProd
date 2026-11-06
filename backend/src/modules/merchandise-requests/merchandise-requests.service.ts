import { withTx, query } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { writeAudit } from '../../services/audit.service';
import { AuthUser } from '../../middleware/auth';
import { createTransferInTransaction } from '../transfers/transfers.service';

type RequestItem = { productId: number; quantity: number };
async function assertWarehouseManager(user: AuthUser, c?: any) { if(user.role==='ADMIN') return; if(user.role!=='ENCARGADO' && !user.permissions?.includes('merchandise_requests.manage')) throw ApiError.forbidden(); const rows=c ? await c.query("SELECT id FROM locations WHERE type='DEPOSITO' AND is_active=true") : await query("SELECT id FROM locations WHERE type='DEPOSITO' AND is_active=true"); if(rows.rows.length!==1 || Number(user.locationId)!==Number(rows.rows[0].id)) throw ApiError.forbidden('Solo el encargado del Depósito Central puede gestionar todos los pedidos.'); }
async function centralWarehouseId(c: any): Promise<number> {
  const r = await c.query<{id:number}>("SELECT id FROM locations WHERE type='DEPOSITO' AND is_active=true ORDER BY id");
  if (r.rows.length !== 1) throw ApiError.conflict('Debe existir exactamente un Depósito Central activo para gestionar pedidos.');
  return r.rows[0].id;
}
export async function listMerchandiseRequests(user: AuthUser, status?: string) {
  const params: unknown[] = [];
  let where = '';
  if (user.role === 'ADMIN' || user.role === 'ENCARGADO' || user.permissions?.includes('merchandise_requests.manage')) {
    await assertWarehouseManager(user);
    const warehouse = await query<{id:number}>("SELECT id FROM locations WHERE type='DEPOSITO' AND is_active=true");
    if (warehouse.rows.length !== 1 || Number(user.locationId) !== Number(warehouse.rows[0].id)) throw ApiError.forbidden();
  }
  const manager = user.role === 'ADMIN' || user.role === 'ENCARGADO' || user.permissions?.includes('merchandise_requests.manage');
  if (!manager) { params.push(user.locationId); where = 'WHERE r.destination_location_id=$1'; }
  if (status) { params.push(status); where += (where ? ' AND ' : 'WHERE ') + 'r.status=$' + params.length; }
  const result = await query(
    `SELECT r.id,r.number,r.status,r.notes,r.created_at,r.destination_location_id,
      dst.name destination_name,u.full_name created_by_name,u.username,
      (SELECT count(*)::int FROM merchandise_request_items i WHERE i.request_id=r.id) item_count,
      r.transfer_id,t.number transfer_number
     FROM merchandise_requests r
     JOIN locations dst ON dst.id=r.destination_location_id
     JOIN users u ON u.id=r.created_by
     LEFT JOIN transfers t ON t.id=r.transfer_id
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
    const manager=user.role==='ADMIN'||user.role==='ENCARGADO'||user.permissions?.includes('merchandise_requests.manage');
    if(manager) await assertWarehouseManager(user,c);
    if(!manager && Number(row.destination_location_id)!==Number(user.locationId)) throw ApiError.forbidden();
    const items=await c.query(`SELECT i.*,p.code,p.barcode,p.name,p.unit FROM merchandise_request_items i
      JOIN products p ON p.id=i.product_id WHERE i.request_id=$1 ORDER BY p.name`,[id]);
    return { ...row, items:items.rows };
  });
}
export async function createMerchandiseRequest(user: AuthUser, items: RequestItem[], notes?: string) {
  if(!user.locationId) throw ApiError.forbidden('Tu usuario no tiene una sucursal asignada.');
  if(user.role==='TRANSPORTE') throw ApiError.forbidden();
  const merged=new Map<number,number>();
  for(const it of items){ if(!Number.isInteger(it.productId)||it.productId<=0||!Number.isFinite(it.quantity)||it.quantity<3) throw ApiError.badRequest('Cada producto debe tener una cantidad mínima de 3 unidades.'); merged.set(it.productId,(merged.get(it.productId)||0)+it.quantity); }
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
    await writeAudit(c,{userId:user.id,action:'MERCHANDISE_REQUEST_CREATE',entity:'merchandise_request',entityId:id,details:{number,items:ids.length,destination:user.locationId},ip:undefined});
    return {id,number,status:'PENDIENTE'};
  });
}
export async function dispatchMerchandiseRequest(user: AuthUser, id: number, items: RequestItem[], ip?: string) {
  await assertWarehouseManager(user);
  return withTx(async c=>{
    const req=await c.query(`SELECT * FROM merchandise_requests WHERE id=$1 FOR UPDATE`,[id]);
    const r=req.rows[0]; if(!r) throw ApiError.notFound('Pedido no encontrado');
    if(r.transfer_id) return {transferId:r.transfer_id,alreadyDispatched:true};
    if(!['PENDIENTE','EN_PREPARACION'].includes(r.status)) throw ApiError.conflict('El pedido ya no se puede despachar.');
    const stored=await c.query('SELECT product_id,quantity_requested FROM merchandise_request_items WHERE request_id=$1 ORDER BY product_id',[id]);
    const allowed=new Map(stored.rows.map(x=>[Number(x.product_id),Number(x.quantity_requested)]));
    const merged=new Map<number,number>();
    for(const it of items){ if(!allowed.has(it.productId)||!Number.isFinite(it.quantity)||it.quantity<3||it.quantity>allowed.get(it.productId)!) throw ApiError.badRequest('Las cantidades despachadas deben ser de al menos 3 y no superar lo solicitado.'); merged.set(it.productId,(merged.get(it.productId)||0)+it.quantity); }
    if(!merged.size) throw ApiError.badRequest('El pedido debe incluir productos para despachar.');
    const transfer=await createTransferInTransaction(c,user,ip,{originLocationId:Number(r.origin_location_id),destinationLocationId:Number(r.destination_location_id),notes:`Pedido ${r.number}`,items:[...merged].map(([productId,quantity])=>({productId,quantity}))});
    if(transfer.status!=='EN_TRANSITO') throw ApiError.conflict('La transferencia requiere aprobación y no pudo despacharse automáticamente. Resuelve la aprobación desde Transferencias.');
    await c.query('UPDATE merchandise_request_items SET quantity_to_dispatch=$1 WHERE request_id=$2 AND product_id=$3',[[...merged.values()],id,0]).catch(()=>undefined);
    for(const [productId,quantity] of merged) await c.query('UPDATE merchandise_request_items SET quantity_to_dispatch=$1 WHERE request_id=$2 AND product_id=$3',[quantity,id,productId]);
    await c.query("UPDATE merchandise_requests SET status='DESPACHADO',transfer_id=$1,handled_by=$2,handled_at=now(),updated_at=now() WHERE id=$3",[transfer.id,user.id,id]);
    await writeAudit(c,{userId:user.id,action:'MERCHANDISE_REQUEST_DISPATCH',entity:'merchandise_request',entityId:id,details:{transferId:transfer.id,transferNumber:transfer.number},ip});
    return {transferId:transfer.id,transferNumber:transfer.number,status:'EN_TRANSITO'};
  });
}
export async function setMerchandiseRequestStatus(user: AuthUser,id:number,status:'EN_PREPARACION'|'RECHAZADO',reason?:string,ip?:string){
 await assertWarehouseManager(user);
 return withTx(async c=>{const r=await c.query('SELECT id,status FROM merchandise_requests WHERE id=$1 FOR UPDATE',[id]); if(!r.rows[0])throw ApiError.notFound('Pedido no encontrado'); if(r.rows[0].status!=='PENDIENTE')throw ApiError.conflict('El pedido ya fue tomado o resuelto.');
 if(status==='RECHAZADO'&&(!reason||reason.trim().length<5))throw ApiError.badRequest('Indicá el motivo del rechazo.');
 await c.query('UPDATE merchandise_requests SET status=$1,rejection_reason=$2,handled_by=$3,handled_at=now(),updated_at=now() WHERE id=$4',[status,status==='RECHAZADO'?reason!.trim():null,user.id,id]);
 await writeAudit(c,{userId:user.id,action:'MERCHANDISE_REQUEST_STATUS',entity:'merchandise_request',entityId:id,details:{status,reason},ip}); return {ok:true,status};});
}
