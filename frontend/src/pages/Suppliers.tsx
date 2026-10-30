import { useCallback,useEffect,useState } from 'react';
import { api } from '../lib/api';
import { Badge,Button,Card,Field,Input,Modal,PageHeader,Textarea } from '../components/ui';
import { useToast } from '../components/Toast';
import type { Supplier } from '../types';
const empty={name:'',taxId:'',contactName:'',phone:'',email:'',address:'',notes:'',isActive:true};
export default function Suppliers(){
 const toast=useToast(); const [rows,setRows]=useState<Supplier[]>([]); const [loading,setLoading]=useState(true);
 const [includeInactive,setIncludeInactive]=useState(false); const [open,setOpen]=useState(false); const [saving,setSaving]=useState(false);
 const [editing,setEditing]=useState<number|null>(null); const [form,setForm]=useState(empty);
 const load=useCallback(async()=>{setLoading(true);try{const r=await api<{suppliers:Supplier[]}>(`/suppliers?includeInactive=${includeInactive}`);setRows(r.suppliers);}catch(e){toast.error((e as Error).message);}finally{setLoading(false);}},[includeInactive]);
 useEffect(()=>{void load();},[load]);
 function create(){setEditing(null);setForm(empty);setOpen(true);}
 function edit(s:Supplier){setEditing(s.id);setForm({name:s.name,taxId:s.tax_id??'',contactName:s.contact_name??'',phone:s.phone??'',email:s.email??'',address:s.address??'',notes:s.notes??'',isActive:s.is_active});setOpen(true);}
 async function save(){if(form.name.trim().length<2){toast.error('Ingresá el nombre del proveedor');return;}setSaving(true);try{
  const body={name:form.name.trim(),taxId:form.taxId.trim()||null,contactName:form.contactName.trim()||null,phone:form.phone.trim()||null,email:form.email.trim()||null,address:form.address.trim()||null,notes:form.notes.trim()||null,isActive:form.isActive};
  if(editing)await api(`/suppliers/${editing}`,{method:'PUT',body});else await api('/suppliers',{method:'POST',body});
  toast.success(editing?'Proveedor actualizado':'Proveedor creado');setOpen(false);void load();
 }catch(e){toast.error((e as Error).message);}finally{setSaving(false);}}
 return <div><PageHeader title="Proveedores" subtitle="Maestro central de proveedores y datos comerciales" actions={<Button onClick={create}>+ Nuevo proveedor</Button>}/>
 <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 p-3"><p className="text-sm text-slate-500">Un proveedor puede ofrecer muchos productos y cada producto puede tener varios proveedores.</p><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeInactive} onChange={e=>setIncludeInactive(e.target.checked)}/> Incluir inactivos</label></Card>
 <Card>{loading?<p className="p-6 text-sm text-slate-500">Cargando proveedores…</p>:rows.length===0?<p className="p-6 text-center text-sm text-slate-500">No hay proveedores cargados.</p>:
 <div className="divide-y divide-slate-100">{rows.map(s=><div key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-4"><div><div className="flex flex-wrap items-center gap-2"><strong>{s.name}</strong><Badge color={s.is_active?'green':'gray'}>{s.is_active?'Activo':'Inactivo'}</Badge></div><div className="mt-1 flex flex-wrap gap-x-4 text-xs text-slate-500">{s.tax_id&&<span>CUIT: {s.tax_id}</span>}{s.contact_name&&<span>Contacto: {s.contact_name}</span>}{s.phone&&<span>Tel: {s.phone}</span>}{s.email&&<span>{s.email}</span>}</div></div><Button size="sm" variant="secondary" onClick={()=>edit(s)}>Editar</Button></div>)}</div>}</Card>
 <Modal open={open} onClose={()=>setOpen(false)} title={editing?'Editar proveedor':'Nuevo proveedor'} width="lg" footer={<><Button variant="secondary" onClick={()=>setOpen(false)}>Cancelar</Button><Button loading={saving} onClick={save}>Guardar proveedor</Button></>}>
 <div className="grid gap-3 sm:grid-cols-2"><Field label="Razón social / nombre" required className="sm:col-span-2"><Input value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></Field>
 <Field label="CUIT"><Input value={form.taxId} onChange={e=>setForm({...form,taxId:e.target.value})}/></Field><Field label="Persona de contacto"><Input value={form.contactName} onChange={e=>setForm({...form,contactName:e.target.value})}/></Field>
 <Field label="Teléfono"><Input value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})}/></Field><Field label="Email"><Input type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})}/></Field>
 <Field label="Domicilio" className="sm:col-span-2"><Input value={form.address} onChange={e=>setForm({...form,address:e.target.value})}/></Field><Field label="Observaciones" className="sm:col-span-2"><Textarea rows={3} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/></Field>
 {editing&&<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isActive} onChange={e=>setForm({...form,isActive:e.target.checked})}/> Proveedor activo</label>}</div></Modal></div>;
}
