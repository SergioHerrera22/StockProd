import { useCallback,useEffect,useMemo,useState } from 'react';
import { api } from '../lib/api';
import { Badge,Button,Card,Field,Input,Modal,PageHeader,Textarea } from '../components/ui';
import { useToast } from '../components/Toast';
import type { Supplier } from '../types';

const empty={name:'',taxId:'',contactName:'',phone:'',email:'',address:'',notes:'',isActive:true};
type BrandRow={brand:string;product_count:number;supplier_count:number;supplier_id:number|null;supplier_names:string};
export default function Suppliers(){
 const toast=useToast();
 const [rows,setRows]=useState<Supplier[]>([]);
 const [brands,setBrands]=useState<BrandRow[]>([]);
 const [loading,setLoading]=useState(true);
 const [includeInactive,setIncludeInactive]=useState(false);
 const [open,setOpen]=useState(false);
 const [saving,setSaving]=useState(false);
 const [editing,setEditing]=useState<number|null>(null);
 const [form,setForm]=useState(empty);
 const [brandQuery,setBrandQuery]=useState('');
 const [brandAssignments,setBrandAssignments]=useState<Record<string,string>>({});
 const [assigning,setAssigning]=useState<string|null>(null);

 const load=useCallback(async()=>{
  setLoading(true);
  try{
   const [s,b]=await Promise.all([
    api<{suppliers:Supplier[]}>(`/suppliers?includeInactive=${includeInactive}`),
    api<{brands:BrandRow[]}>('/suppliers/brands')
   ]);
   setRows(s.suppliers);setBrands(b.brands);
   setBrandAssignments(Object.fromEntries(b.brands.map(x=>[x.brand,x.supplier_id?String(x.supplier_id):''])));
  }catch(e){toast.error((e as Error).message);}
  finally{setLoading(false);}
 },[includeInactive]);
 useEffect(()=>{void load();},[load]);

 const activeSuppliers=useMemo(()=>rows.filter(s=>s.is_active),[rows]);
 const visibleBrands=useMemo(()=>brands.filter(b=>b.brand.toLocaleLowerCase().includes(brandQuery.toLocaleLowerCase())),[brands,brandQuery]);
 function create(){setEditing(null);setForm(empty);setOpen(true);}
 function edit(s:Supplier){setEditing(s.id);setForm({name:s.name,taxId:s.tax_id??'',contactName:s.contact_name??'',phone:s.phone??'',email:s.email??'',address:s.address??'',notes:s.notes??'',isActive:s.is_active});setOpen(true);}
 async function save(){
  if(form.name.trim().length<2){toast.error('Ingresá el nombre del proveedor');return;}
  setSaving(true);
  try{
   const body={name:form.name.trim(),taxId:form.taxId.trim()||null,contactName:form.contactName.trim()||null,phone:form.phone.trim()||null,email:form.email.trim()||null,address:form.address.trim()||null,notes:form.notes.trim()||null,isActive:form.isActive};
   if(editing)await api(`/suppliers/${editing}`,{method:'PUT',body});else await api('/suppliers',{method:'POST',body});
   toast.success(editing?'Proveedor actualizado':'Proveedor creado');setOpen(false);await load();
  }catch(e){toast.error((e as Error).message);}
  finally{setSaving(false);}
 }
 async function assignBrand(brand:string){
  const supplierId=Number(brandAssignments[brand]);
  if(!supplierId){toast.error('Seleccioná un proveedor para esta marca');return;}
  setAssigning(brand);
  try{
   const r=await api<{productCount:number}>('/suppliers/brands/assign',{method:'POST',body:{brand,supplierId}});
   toast.success(`${brand}: proveedor asignado a ${r.productCount} productos`);
   await load();
  }catch(e){toast.error((e as Error).message);}
  finally{setAssigning(null);}
 }
 async function remove(s:Supplier){
  if(!window.confirm(`¿Eliminar el proveedor "${s.name}"? Si tiene movimientos históricos se archivará para conservar la trazabilidad.`))return;
  try{await api(`/suppliers/${s.id}`,{method:'DELETE'});toast.success('Proveedor eliminado o archivado');await load();}
  catch(e){toast.error((e as Error).message);}
 }

 return <div>
  <PageHeader title="Proveedores" subtitle="Administración de proveedores y asignación de marcas" actions={<Button onClick={create}>+ Nuevo proveedor</Button>}/>
  <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 p-3">
   <p className="text-sm text-slate-500">Asigná una marca completa a un proveedor. La selección se aplica a todos los productos activos de esa marca.</p>
   <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeInactive} onChange={e=>setIncludeInactive(e.target.checked)}/> Incluir inactivos</label>
  </Card>
  <Card className="mb-5">
   <div className="border-b border-slate-100 p-4"><h2 className="font-semibold">Proveedores registrados</h2></div>
   {loading?<p className="p-6 text-sm text-slate-500">Cargando…</p>:rows.length===0?<p className="p-6 text-center text-sm text-slate-500">No hay proveedores cargados.</p>:
    <div className="divide-y divide-slate-100">{rows.map(s=><div key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
     <div><div className="flex flex-wrap items-center gap-2"><strong>{s.name}</strong><Badge color={s.is_active?'green':'gray'}>{s.is_active?'Activo':'Inactivo'}</Badge></div>
      <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-slate-500">{s.tax_id&&<span>CUIT: {s.tax_id}</span>}{s.contact_name&&<span>Contacto: {s.contact_name}</span>}{s.phone&&<span>Tel: {s.phone}</span>}{s.email&&<span>{s.email}</span>}</div>
     </div><div className="flex gap-2"><Button size="sm" variant="secondary" onClick={()=>edit(s)}>Editar</Button><Button size="sm" variant="danger" onClick={()=>void remove(s)}>Eliminar</Button></div>
    </div>)}</div>}
  </Card>

  <Card>
   <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4"><div><h2 className="font-semibold">Asignación de proveedores por marca</h2><p className="mt-1 text-xs text-slate-500">Cada marca aparece una sola vez; al asignarla, todos sus productos activos quedan asociados al proveedor elegido.</p></div>
    <Input value={brandQuery} onChange={e=>setBrandQuery(e.target.value)} placeholder="Buscar marca…" className="max-w-xs"/>
   </div>
   {loading?<p className="p-6 text-sm text-slate-500">Cargando marcas…</p>:visibleBrands.length===0?<p className="p-6 text-sm text-slate-500">No se encontraron marcas en el catálogo.</p>:
    <div className="divide-y divide-slate-100">{visibleBrands.map(b=><div key={b.brand} className="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_minmax(220px,320px)_auto] md:items-center">
     <div><strong>{b.brand}</strong><p className="text-xs text-slate-500">{b.product_count} productos activos</p>{b.supplier_count>1&&<p className="text-xs text-amber-700">Actualmente vinculada a varios proveedores: {b.supplier_names}</p>}</div>
     <select className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={brandAssignments[b.brand]??''} onChange={e=>setBrandAssignments(old=>({...old,[b.brand]:e.target.value}))}>
      <option value="">Seleccionar proveedor…</option>{activeSuppliers.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
     </select>
     <Button size="sm" disabled={!brandAssignments[b.brand]||assigning===b.brand} loading={assigning===b.brand} onClick={()=>void assignBrand(b.brand)}>Asignar a toda la marca</Button>
    </div>)}</div>}
  </Card>

  <Modal open={open} onClose={()=>setOpen(false)} title={editing?'Editar proveedor':'Nuevo proveedor'} width="lg" footer={<><Button variant="secondary" onClick={()=>setOpen(false)}>Cancelar</Button><Button loading={saving} onClick={save}>Guardar proveedor</Button></>}>
   <div className="grid gap-3 sm:grid-cols-2"><Field label="Razón social / nombre" required className="sm:col-span-2"><Input value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></Field>
    <Field label="CUIT"><Input value={form.taxId} onChange={e=>setForm({...form,taxId:e.target.value})}/></Field><Field label="Persona de contacto"><Input value={form.contactName} onChange={e=>setForm({...form,contactName:e.target.value})}/></Field>
    <Field label="Teléfono"><Input value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})}/></Field><Field label="Email"><Input type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})}/></Field>
    <Field label="Domicilio" className="sm:col-span-2"><Input value={form.address} onChange={e=>setForm({...form,address:e.target.value})}/></Field><Field label="Observaciones" className="sm:col-span-2"><Textarea rows={3} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/></Field>
    {editing&&<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isActive} onChange={e=>setForm({...form,isActive:e.target.checked})}/> Proveedor activo</label>}
   </div>
  </Modal>
 </div>;
}
