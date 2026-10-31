import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as XLSX from 'xlsx';
import JsBarcode from 'jsbarcode';
import { api, qs } from '../lib/api';
import { useAuth } from '../store/auth';

type Issue = 'no_barcode' | 'no_supplier' | 'no_description' | 'multiple';
type QualityProduct = {
  id:number; code:string; name:string; barcode:string|null; description:string|null;
  brand:string|null; has_supplier:boolean; updated_at:string;
};
type BulkRow = { code:string; name?:string; description?:string; brand?:string; barcode?:string; supplier?:string };
type PreviewRow = { code:string; id?:number; updatedAt?:string; status:'not_found'|'changes'|'unchanged'; changes:{field:string;from:unknown;to:unknown}[] };
type CatalogProduct = { id:number; code:string; name:string; barcode:string|null; brand:string|null };

const issueLabels:Record<Issue,string> = {
  no_barcode:'Sin código de barras', no_supplier:'Sin proveedor asociado',
  no_description:'Sin descripción', multiple:'Todos los pendientes',
};

function ActionCard({icon,title,description,label,disabled,onClick}:{icon:string;title:string;description:string;label:string;disabled?:boolean;onClick:()=>void}) {
  return <section className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
    <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-2xl">{icon}</div>
    <h2 className="font-semibold text-slate-800">{title}</h2><p className="mt-1 flex-1 text-sm leading-6 text-slate-500">{description}</p>
    <button type="button" disabled={disabled} onClick={onClick} className="mt-4 rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-50">{label}</button>
  </section>;
}

export default function LoadCenter() {
  const navigate=useNavigate();
  const canWrite=useAuth((s)=>s.can('products.write'));
  const [tab,setTab]=useState<'home'|'quality'|'bulk'|'labels'>('home');
  const [issue,setIssue]=useState<Issue>('multiple');
  const [qualityQ,setQualityQ]=useState('');
  const [quality,setQuality]=useState<QualityProduct[]>([]);
  const [summary,setSummary]=useState({no_barcode:0,no_supplier:0,no_description:0});
  const [qualityTotal,setQualityTotal]=useState(0);
  const [qualityPage,setQualityPage]=useState(1);
  const [qualityLoading,setQualityLoading]=useState(false);
  const [bulkRows,setBulkRows]=useState<BulkRow[]>([]);
  const [bulkPreview,setBulkPreview]=useState<PreviewRow[]>([]);
  const [bulkTotals,setBulkTotals]=useState({found:0,notFound:0,changed:0,unchanged:0});
  const [bulkBusy,setBulkBusy]=useState(false);
  const [bulkFileName,setBulkFileName]=useState('');
  const [labelQ,setLabelQ]=useState('');
  const [labelResults,setLabelResults]=useState<CatalogProduct[]>([]);
  const [selectedLabels,setSelectedLabels]=useState<CatalogProduct[]>([]);
  const [labelBusy,setLabelBusy]=useState(false);
  const [labelCopies,setLabelCopies]=useState(1);

  async function loadQuality() {
    setQualityLoading(true);
    try {
      const r=await api<{products:QualityProduct[];total:number;summary:{no_barcode:number;no_supplier:number;no_description:number}}>(
        '/products/quality'+qs({issue,q:qualityQ,page:qualityPage,pageSize:25}));
      setQuality(r.products); setQualityTotal(r.total); setSummary(r.summary);
    } catch(e) { window.alert((e as Error).message); }
    finally { setQualityLoading(false); }
  }
  useEffect(()=>{ if(tab==='quality') void loadQuality(); },[tab,issue,qualityPage,qualityQ]);

  async function readBulkFile(file:File) {
    setBulkFileName(file.name); setBulkPreview([]); setBulkRows([]);
    try {
      const bytes=await file.arrayBuffer();
      let workbook:XLSX.WorkBook;
      if(/\.html?$/i.test(file.name)) {
        const html=new TextDecoder('windows-1252').decode(bytes);
        const table=html.match(/<table[\s\S]*?<\/table>/i)?.[0];
        if(!table) throw new Error('No se encontró una tabla HTML en el archivo');
        workbook=XLSX.read(table,{type:'string'});
      } else if(/\.csv$/i.test(file.name)) {
        const raw=new Uint8Array(bytes);
        let csv:string; try { csv=new TextDecoder('utf-8',{fatal:true}).decode(raw); } catch { csv=new TextDecoder('windows-1252').decode(raw); }
        workbook=XLSX.read(csv,{type:'string'});
      } else workbook=XLSX.read(bytes,{type:'array'});
      const matrix=XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[workbook.SheetNames[0]],{header:1,defval:''});
      if(!matrix.length) throw new Error('El archivo no contiene filas');
      const norm=(v:unknown)=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
      const headers=(matrix[0] as unknown[]).map(norm);
      const find=(...names:string[])=>headers.findIndex((h)=>names.includes(h));
      const codeCol=find('codart','codigo','cod','code','articulo');
      const descCol=find('desc','descripcion','nombre','detalle','denominacion');
      const supplierCol=find('razon','proveedor','supplier','razonsocial');
      const brandCol=find('marca','brand');
      const barcodeCol=find('barcode','barras','codigodebarras','ean');
      if(codeCol<0) throw new Error('No se detectó CODART/código. Revisá los encabezados del archivo.');
      const rows:BulkRow[]=[];
      for(const line of matrix.slice(1)) {
        const cell=(i:number)=>i<0?'':String((line as unknown[])[i]??'').replace(/[\u00A0\u200B\uFEFF]/g,' ').replace(/\s+/g,' ').trim();
        const code=cell(codeCol).replace(/\.0+$/,'');
        if(!code) continue;
        const row:BulkRow={code};
        if(descCol>=0 && cell(descCol)) row.name=cell(descCol);
        if(supplierCol>=0 && cell(supplierCol)) row.supplier=cell(supplierCol);
        if(brandCol>=0 && cell(brandCol)) row.brand=cell(brandCol);
        if(barcodeCol>=0 && cell(barcodeCol)) row.barcode=cell(barcodeCol);
        rows.push(row);
      }
      if(!rows.length) throw new Error('No se encontraron filas con código de artículo');
      setBulkRows(rows);
    } catch(e) { window.alert((e as Error).message); }
  }

  async function previewBulk() {
    if(!bulkRows.length) return;
    setBulkBusy(true);
    try {
      const r=await api<{preview:PreviewRow[];totals:typeof bulkTotals}>('/products/bulk-edit/preview',{method:'POST',body:{rows:bulkRows}});
      setBulkPreview(r.preview); setBulkTotals(r.totals);
    } catch(e) { window.alert((e as Error).message); }
    finally { setBulkBusy(false); }
  }

  async function applyBulk() {
    const rows=bulkPreview.filter((p)=>p.status==='changes' && p.updatedAt).map((p)=>{
      const original=bulkRows.find((r)=>r.code.toLowerCase()===p.code.toLowerCase())!;
      return {...original,updatedAt:p.updatedAt!};
    });
    if(!rows.length) return;
    if(!window.confirm('Se aplicarán únicamente los campos presentes en el archivo. Los proveedores actuales se conservan y el proveedor indicado se agrega sin borrar vínculos. ¿Continuar?')) return;
    setBulkBusy(true);
    try {
      const r=await api<{updated:number;conflicts:number;notFound:number;conflictCodes:string[]}>('/products/bulk-edit/apply',{method:'POST',body:{rows}});
      window.alert(`Actualizados: ${r.updated}\nConflictos por cambios concurrentes: ${r.conflicts}\nNo encontrados: ${r.notFound}${r.conflictCodes.length?'\nRevisar: '+r.conflictCodes.join(', '):''}`);
      setBulkPreview([]);
    } catch(e) { window.alert((e as Error).message); }
    finally { setBulkBusy(false); }
  }

  async function searchLabels() {
    if(!labelQ.trim()) return;
    setLabelBusy(true);
    try {
      const r=await api<{products:CatalogProduct[]}>('/products'+qs({q:labelQ,active:'true',page:1,pageSize:100}));
      setLabelResults(r.products);
    } catch(e) { window.alert((e as Error).message); }
    finally { setLabelBusy(false); }
  }
  function toggleLabel(p:CatalogProduct) {
    setSelectedLabels((old)=>old.some((x)=>x.id===p.id)?old.filter((x)=>x.id!==p.id):[...old,p]);
  }
  function printBatchLabels() {
    const items=selectedLabels.filter((p)=>p.barcode);
    if(!items.length) { window.alert('Los productos seleccionados no tienen código de barras.'); return; }
    const esc=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const labels=items.flatMap((p)=>Array.from({length:Math.max(1,Math.min(20,labelCopies))},()=> {
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
      try { JsBarcode(svg,p.barcode!,{format:/^\d{13}$/.test(p.barcode!)?'EAN13':'CODE128',height:35,width:1.35,displayValue:true,margin:2}); }
      catch { return ''; }
      return `<div class="label"><b>${esc(p.name)}</b><small>${esc(p.code)}</small>${p.brand?'<small>'+esc(p.brand)+'</small>':''}${svg.outerHTML}</div>`;
    })).join('');
    const win=window.open('','_blank','width=1000,height=800');
    if(!win) { window.alert('El navegador bloqueó la ventana de impresión. Permití ventanas emergentes.'); return; }
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Etiquetas de productos</title><style>@page{margin:6mm}body{font-family:Arial;margin:0}.sheet{display:grid;grid-template-columns:repeat(5,38mm);gap:2mm}.label{height:21mm;width:38mm;box-sizing:border-box;border:.25mm dashed #bbb;display:flex;align-items:center;justify-content:center;flex-direction:column;overflow:hidden;padding:1mm;text-align:center}.label b{font-size:8px;line-height:1.1;max-height:2.2em;overflow:hidden}.label small{font-size:6px}.label svg{max-width:35mm;max-height:11mm}</style></head><body><div class="sheet">${labels}</div><script>window.onload=()=>window.print()<\/script></body></html>`);
    win.document.close();
  }

  const selectedCount=selectedLabels.length;
  const readyLabels=useMemo(()=>selectedLabels.filter((p)=>p.barcode).length,[selectedLabels]);

  return <div className="space-y-6">
    <header><p className="text-xs font-semibold uppercase tracking-wider text-brand-700">Catálogo · Operaciones</p>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Centro de carga</h1>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">Mantenimiento controlado del catálogo. Ninguna de estas herramientas modifica existencias ni genera movimientos de stock.</p></header>
    <nav className="flex flex-wrap gap-2">
      {([{id:'home',label:'Resumen'},{id:'quality',label:'Productos pendientes'},{id:'bulk',label:'Edición masiva'},{id:'labels',label:'Etiquetas por lote'}] as const).map((x)=>
        <button key={x.id} onClick={()=>setTab(x.id)} className={`rounded-lg px-3 py-2 text-sm font-semibold ${tab===x.id?'bg-brand-700 text-white':'border border-slate-200 bg-white text-slate-600'}`}>{x.label}</button>)}
    </nav>

    {tab==='home' && <>
      {!canWrite && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Tenés acceso de consulta. Para cargar o modificar productos necesitás el permiso products.write.</div>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <ActionCard icon="📄" title="Importar catálogo" label="Importar Excel / CSV / HTML" description="Importación existente con revisión previa. También admite exportes HTML con CODART, DESC y RAZON desde la edición masiva." disabled={!canWrite} onClick={()=>navigate('/productos?accion=importar')}/>
        <ActionCard icon="📷" title="Carga continua de barras" label="Abrir lector continuo" description="Identificá cada producto, escaneá su EAN con lector USB/Bluetooth o generá un EAN-13 interno." disabled={!canWrite} onClick={()=>navigate('/productos?accion=barras')}/>
        <ActionCard icon="➕" title="Alta individual" label="Crear producto" description="Alta con descripción, unidad, categoría y proveedores asociados." disabled={!canWrite} onClick={()=>navigate('/productos?accion=nuevo')}/>
        <ActionCard icon="🔎" title="Productos pendientes" label="Revisar calidad" description="Detectá productos activos sin barras, proveedor o descripción." onClick={()=>setTab('quality')}/>
        <ActionCard icon="📊" title="Edición masiva" label="Comparar archivo" description="Importá un Excel/CSV/HTML, revisá diferencias y aplicá solo los campos enviados." disabled={!canWrite} onClick={()=>setTab('bulk')}/>
        <ActionCard icon="🏷️" title="Etiquetas por lote" label="Preparar impresión" description="Seleccioná productos del catálogo y generá hojas de etiquetas en una sola impresión." onClick={()=>setTab('labels')}/>
      </div>
      <section className="rounded-xl border border-blue-200 bg-blue-50 p-4"><h2 className="font-semibold text-blue-900">Protecciones</h2>
        <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-blue-900/80"><li>Edición por campos presentes: los campos ausentes no se modifican.</li><li>Los proveedores existentes nunca se eliminan; los nuevos se agregan al vínculo.</li><li>La aplicación verifica que el producto no haya cambiado desde la vista previa.</li><li>Los procesos de catálogo no modifican stock.</li></ul></section>
    </>}

    {tab==='quality' && <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap gap-3">{[['no_barcode','Sin barras',summary.no_barcode],['no_supplier','Sin proveedor',summary.no_supplier],['no_description','Sin descripción',summary.no_description]] .map(([key,label,count])=><div key={String(key)} className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">{label}</div><b className="text-xl">{count}</b></div>)}</div>
      <div className="flex flex-wrap gap-2"><select value={issue} onChange={(e)=>{setIssue(e.target.value as Issue);setQualityPage(1)}} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">{Object.entries(issueLabels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select>
        <input value={qualityQ} onChange={(e)=>{setQualityQ(e.target.value);setQualityPage(1)}} placeholder="Buscar por código o descripción" className="min-w-[220px] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"/></div>
      {qualityLoading?<p className="py-8 text-center text-sm text-slate-500">Consultando catálogo…</p>:<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b text-xs text-slate-500"><th className="p-2">Código</th><th className="p-2">Producto</th><th className="p-2">Barras</th><th className="p-2">Proveedor</th><th className="p-2">Descripción</th><th/></tr></thead><tbody>{quality.map(p=><tr key={p.id} className="border-b border-slate-100"><td className="p-2 font-mono">{p.code}</td><td className="p-2">{p.name}</td><td className="p-2">{p.barcode?'Sí':'<escape>—</escape>'}</td><td className="p-2">{p.has_supplier?'Sí':'No'}</td><td className="p-2">{p.description?.trim()?'Sí':'No'}</td><td className="p-2"><button onClick={()=>navigate('/productos?q='+encodeURIComponent(p.code))} className="text-brand-700 underline">Abrir</button></td></tr>)}</tbody></table></div>}
      <div className="flex items-center justify-between text-sm"><span>{qualityTotal} resultados</span><div className="flex gap-2"><button disabled={qualityPage<=1} onClick={()=>setQualityPage(p=>p-1)} className="rounded border px-3 py-1 disabled:opacity-40">Anterior</button><span className="py-1">Página {qualityPage}</span><button disabled={qualityPage*25>=qualityTotal} onClick={()=>setQualityPage(p=>p+1)} className="rounded border px-3 py-1 disabled:opacity-40">Siguiente</button></div></div>
    </section>}

    {tab==='bulk' && <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
      <div><h2 className="font-semibold text-slate-800">Edición masiva segura</h2><p className="mt-1 text-sm text-slate-500">Columnas admitidas: código/CODART, nombre/DESC, descripción, marca, barras y proveedor/RAZON. Las columnas que no estén presentes no se alteran.</p></div>
      {!canWrite&&<p className="rounded bg-amber-50 p-3 text-sm text-amber-800">Necesitás products.write para aplicar cambios.</p>}
      <input type="file" accept=".xlsx,.xls,.csv,.html,.htm" disabled={!canWrite||bulkBusy} onChange={e=>{const file=e.target.files?.[0];if(file)void readBulkFile(file)}}/>
      {bulkFileName&&<p className="text-xs text-slate-500">{bulkFileName} · {bulkRows.length} filas preparadas</p>}
      {bulkRows.length>0&&<><div className="max-h-56 overflow-auto rounded border"><table className="w-full text-xs"><thead><tr><th className="p-2 text-left">Código</th><th className="p-2 text-left">Nombre</th><th className="p-2 text-left">Proveedor</th></tr></thead><tbody>{bulkRows.slice(0,30).map((r,i)=><tr key={i} className="border-t"><td className="p-2 font-mono">{r.code}</td><td className="p-2">{r.name??'—'}</td><td className="p-2">{r.supplier??'—'}</td></tr>)}</tbody></table></div>
      <button disabled={!canWrite||bulkBusy} onClick={()=>void previewBulk()} className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{bulkBusy?'Procesando…':'Comparar con catálogo'}</button></>}
      {bulkPreview.length>0&&<><div className="grid grid-cols-2 gap-2 md:grid-cols-4">{Object.entries(bulkTotals).map(([k,v])=><div key={k} className="rounded bg-slate-50 p-3"><div className="text-xs capitalize text-slate-500">{k}</div><b className="text-xl">{v}</b></div>)}</div>
      <div className="max-h-72 overflow-auto rounded border"><table className="w-full text-xs"><thead><tr><th className="p-2 text-left">Código</th><th className="p-2 text-left">Estado</th><th className="p-2 text-left">Diferencias</th></tr></thead><tbody>{bulkPreview.map((p,i)=><tr key={i} className="border-t"><td className="p-2 font-mono">{p.code}</td><td className="p-2">{p.status==='changes'?'Con cambios':p.status==='not_found'?'No encontrado':'Sin cambios'}</td><td className="p-2">{p.changes.map(c=>c.field).join(', ')||'—'}</td></tr>)}</tbody></table></div>
      <button disabled={!canWrite||bulkBusy||!bulkTotals.changed} onClick={()=>void applyBulk()} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{bulkBusy?'Aplicando…':`Aplicar ${bulkTotals.changed} productos modificados`}</button></>}
    </section>}

    {tab==='labels' && <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
      <div><h2 className="font-semibold">Impresión de etiquetas por lote</h2><p className="mt-1 text-sm text-slate-500">Buscá por código o descripción, seleccioná productos y generá etiquetas de 38 × 21 mm. No incluye productos sin código de barras.</p></div>
      <form className="flex gap-2" onSubmit={e=>{e.preventDefault();void searchLabels()}}><input value={labelQ} onChange={e=>setLabelQ(e.target.value)} placeholder="Código o descripción" className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm"/><button disabled={labelBusy} className="rounded-lg border px-4 py-2 text-sm">{labelBusy?'Buscando…':'Buscar'}</button></form>
      {labelResults.length>0&&<div className="max-h-64 overflow-auto rounded border">{labelResults.map(p=><label key={p.id} className="flex items-center gap-3 border-b p-2 text-sm"><input type="checkbox" checked={selectedLabels.some(x=>x.id===p.id)} onChange={()=>toggleLabel(p)}/><span className="min-w-0 flex-1"><b className="block truncate">{p.name}</b><small className="font-mono text-slate-500">{p.code} · {p.barcode??'Sin barras'}</small></span>{!p.barcode&&<small className="text-amber-700">Sin barras</small>}</label>)}</div>}
      <div className="flex flex-wrap items-end justify-between gap-3 border-t pt-3"><div className="flex items-end gap-3"><label className="text-xs text-slate-500">Copias por producto<input type="number" min="1" max="20" value={labelCopies} onChange={e=>setLabelCopies(Math.max(1,Math.min(20,Number(e.target.value)||1)))} className="mt-1 block w-20 rounded border px-2 py-2 text-sm"/></label><p className="text-xs text-slate-500">{selectedCount} seleccionados · {readyLabels} listos para imprimir</p></div><button disabled={!readyLabels} onClick={printBatchLabels} className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Imprimir lote</button></div>
    </section>}
  </div>;
}
