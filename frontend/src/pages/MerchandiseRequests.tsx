import { useCallback,useEffect,useState } from 'react';
import { api,qs } from '../lib/api';
import { useAuth } from '../store/auth';
import { fmtDateTime,fmtQty } from '../lib/format';
import { ScanInput } from '../components/ScanInput';
import { Badge,Button,Card,Field,Input,PageHeader,Textarea } from '../components/ui';
import { useToast } from '../components/Toast';

type Req={id:number;number:string;status:string;notes:string|null;created_at:string;destination_name:string;created_by_name:string;item_count:number};
type ProductOption={id:number;code:string;barcode:string|null;name:string;brand:string|null;unit:string};
type Item={productId:number;code:string;name:string;quantity:number;unit:string};
type Detail=Req & {origin_name:string;items:Array<{id:number;product_id:number;quantity_requested:string;code:string;name:string;unit:string}>};
const stateLabel:Record<string,string>={PENDIENTE:'Pendiente',VISTO:'Visto',EN_PREPARACION:'Preparado',ATENDIDO:'Atendido',RECHAZADO:'Rechazado'};
export default function MerchandiseRequests(){
 const {user,can}=useAuth(); const toast=useToast();
 const [q,setQ]=useState(''); const [results,setResults]=useState<ProductOption[]>([]); const [cart,setCart]=useState<Item[]>([]);
 const [notes,setNotes]=useState(''); const [rows,setRows]=useState<Req[]>([]); const [detail,setDetail]=useState<Detail|null>(null);
 const [busy,setBusy]=useState(false);
 const manager=can('merchandise_requests.manage');
 const load=useCallback(async()=>{try{const r=await api<{requests:Req[]}>('/merchandise-requests');setRows(r.requests);}catch(e){toast.error((e as Error).message);}},[]);
 useEffect(()=>{void load();},[load]);
 const search=useCallback(async(term:string)=>{const v=term.trim();if(!v)return [];try{const r=await api<{products:ProductOption[]}>(`/merchandise-requests/products${qs({q:v})}`);setResults(r.products);return r.products;}catch(e){toast.error((e as Error).message);return []; }},[]);
 async function addByCode(code:string){const term=code.trim();setQ(term);const products=await search(term);const exact=products.filter(p=>p.code.toLocaleLowerCase()===term.toLocaleLowerCase()||(p.barcode||'').toLocaleLowerCase()===term.toLocaleLowerCase());if(exact.length===1){add(exact[0]);return;}if(products.length===1 && (products[0].code.toLocaleLowerCase()===term.toLocaleLowerCase()||(products[0].barcode||'').toLocaleLowerCase()===term.toLocaleLowerCase())){add(products[0]);}}
 function add(p:ProductOption){setCart(old=>old.some(x=>x.productId===p.id)?old:[...old,{productId:p.id,code:p.code,name:p.name,quantity:3,unit:p.unit}]);setResults([]);setQ('');}
 async function submit(){if(!cart.length)return;for(const x of cart)if(!Number.isFinite(x.quantity)||x.quantity<=0||Math.abs(x.quantity*1000-Math.round(x.quantity*1000))>1e-7){toast.error('Ingresá una cantidad mayor a cero, con hasta 3 decimales.');return;}setBusy(true);try{const r=await api<{number:string}>('/merchandise-requests',{method:'POST',body:{items:cart.map(x=>({productId:x.productId,quantity:x.quantity})),notes}});toast.success(`Pedido ${r.number} enviado`);setCart([]);setNotes('');void load();}catch(e){toast.error((e as Error).message);}finally{setBusy(false);}}
 async function openDetail(r:Req){try{const d=await api<{request:Detail}>(`/merchandise-requests/${r.id}`);setDetail(d.request);}catch(e){toast.error((e as Error).message);}}
 async function action(path:string,body?:unknown){if(!detail)return;setBusy(true);try{await api(path,{method:'POST',body});toast.success('Pedido actualizado');setDetail(null);void load();}catch(e){toast.error((e as Error).message);}finally{setBusy(false);}}
 function reject(){if(!detail)return;const reason=window.prompt('Motivo del rechazo (mínimo 5 caracteres):');if(!reason||reason.trim().length<5)return;void action(`/merchandise-requests/${detail.id}/reject`,{reason});}
 return <div className="space-y-4">
 <PageHeader title="Pedir Mercadería" subtitle={manager?'Bandeja general de pedidos de las sucursales':'Buscá, escaneá y enviá tu pedido al Depósito Central'}/>
 {!manager&&<Card className="space-y-3 p-4">
  <div className="grid gap-2 sm:grid-cols-2"><div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">Origen</div><strong>Depósito Central</strong></div><div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">Destino</div><strong>{user?.locationId?'Sucursal asignada a tu usuario':'Sin sucursal asignada'}</strong></div></div>
  <Field label="Buscar o escanear producto"><ScanInput autoFocus onScan={addByCode} placeholder="Escaneá el código de barras o escribí el código/nombre…"/></Field>
  {q&&<Button size="sm" variant="secondary" onClick={()=>void search(q)}>Buscar</Button>}
  {results.length>0&&<div className="max-h-64 divide-y overflow-y-auto rounded-lg border">{results.map(p=><button key={p.id} onClick={()=>add(p)} className="flex w-full items-center justify-between p-3 text-left hover:bg-slate-50"><span><b>{p.name}</b><small className="block text-slate-500">{p.code}{p.brand?' · '+p.brand:''}</small></span><span className="text-sm text-brand-700">Seleccionar</span></button>)}</div>}
  <h3 className="font-semibold">Productos del pedido ({cart.length})</h3>
  {cart.length===0?<p className="rounded-lg bg-slate-50 p-5 text-center text-sm text-slate-500">Escaneá o buscá un producto para comenzar.</p>:<div className="divide-y rounded-lg border">{cart.map(x=><div key={x.productId} className="flex flex-wrap items-center justify-between gap-2 p-3"><div><b>{x.name}</b><small className="block text-slate-500">{x.code}</small></div><div className="flex items-center gap-2"><Input type="number" min="0.001" step="0.001" className="w-24" value={x.quantity} onChange={e=>setCart(old=>old.map(y=>y.productId===x.productId?{...y,quantity:Number(e.target.value)}:y))}/><Button size="sm" variant="ghost" onClick={()=>setCart(old=>old.filter(y=>y.productId!==x.productId))}>Quitar</Button></div><small className="w-full text-slate-500">Cantidad en {x.unit} · admite hasta 3 decimales</small></div>)}</div>}
  <Field label="Observaciones (opcional)"><Textarea rows={2} value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Aclaraciones para el depósito…"/></Field>
  <Button className="w-full" disabled={!cart.length||busy} loading={busy} onClick={()=>void submit()}>Enviar pedido al Depósito Central</Button>
 </Card>}
 <Card className="p-3"><div className="mb-3 flex items-center justify-between"><h3 className="font-semibold">{manager?'Todos los pedidos':'Mis pedidos'}</h3><Button size="sm" variant="secondary" onClick={()=>void load()}>Actualizar</Button></div>
 {rows.length===0?<p className="p-6 text-center text-sm text-slate-500">No hay pedidos registrados.</p>:<div className="divide-y">{rows.map(r=><button key={r.id} onClick={()=>void openDetail(r)} className="flex w-full flex-wrap items-center justify-between gap-2 py-3 text-left hover:bg-slate-50"><span><b>{r.number}</b><small className="block text-slate-500">{manager?r.destination_name+' · ':''}{r.created_by_name} · {fmtDateTime(r.created_at)}</small></span><span className="text-right"><Badge color={r.status==='ATENDIDO'?'green':r.status==='RECHAZADO'?'red':r.status==='PENDIENTE'?'amber':'blue'}>{stateLabel[r.status]||r.status}</Badge><small className="block text-slate-500">{r.item_count} productos</small></span></button>)}</div>}
 </Card>
 {detail&&<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3"><Card className="max-h-[90vh] w-full max-w-2xl space-y-3 overflow-y-auto p-4"><div className="flex justify-between"><h3 className="text-lg font-bold">{detail.number}</h3><Button variant="ghost" onClick={()=>setDetail(null)}>Cerrar</Button></div><div className="grid grid-cols-2 gap-2 text-sm"><div><small className="block text-slate-500">Origen</small>{detail.origin_name}</div><div><small className="block text-slate-500">Destino</small>{detail.destination_name}</div><div><small className="block text-slate-500">Solicitó</small>{detail.created_by_name}</div><div><small className="block text-slate-500">Estado</small>{stateLabel[detail.status]}</div></div>
 <div className="divide-y rounded-lg border">{detail.items.map(i=><div key={i.id} className="flex items-center justify-between gap-2 p-3"><span><b>{i.name}</b><small className="block text-slate-500">{i.code} · Solicitado: {fmtQty(i.quantity_requested)} {i.unit}</small></span><b>{fmtQty(i.quantity_requested)}</b></div>)}</div>
 {detail.notes&&<p className="text-sm text-slate-600">Observaciones: {detail.notes}</p>}

 {manager&&['PENDIENTE','VISTO','EN_PREPARACION'].includes(detail.status)&&<div className="flex flex-wrap justify-end gap-2">{detail.status==='PENDIENTE'&&<Button variant="secondary" disabled={busy} onClick={()=>void action('/merchandise-requests/'+detail.id+'/seen')}>Marcar visto</Button>}<Button variant="secondary" disabled={busy} onClick={()=>void action('/merchandise-requests/'+detail.id+'/preparing')}>Marcar preparado</Button><Button variant="danger" disabled={busy} onClick={reject}>Rechazar</Button><Button loading={busy} disabled={busy} onClick={()=>void action('/merchandise-requests/'+detail.id+'/attended')}>Marcar atendido</Button></div>}
 </Card></div>}
 </div>;
}
