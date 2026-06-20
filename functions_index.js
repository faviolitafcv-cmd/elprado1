const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onValueCreated } = require('firebase-functions/v2/database');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

admin.initializeApp();
const db = admin.database();

const CONFIG = {
  ultramsg_instance: 'instance181718',
  ultramsg_token: 'j51iaa51v550avsw',
  dias_monitoreo: 14,
  firebase_path: 'elprado1'
};

async function getContactos() {
  const snap = await db.ref('elprado1/sanidad/contactos_alerta').once('value');
  const data = snap.val();
  if(!data) return ['59168753525'];
  const lista = Array.isArray(data) ? data : Object.values(data);
  return lista.filter(Boolean).map(c=>c.numero).filter(Boolean);
}

async function enviarWhatsApp(mensaje, numeros) {
  const url = 'https://api.ultramsg.com/' + CONFIG.ultramsg_instance + '/messages/chat';
  const targets = numeros || ['59168753525'];
  for(const num of targets){
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: CONFIG.ultramsg_token, to: num, body: mensaje })
    });
  }
}

function calcProximoMonitoreo(hpgList, aplicList, nombreGrupo) {
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const ultHPG = hpgList.filter(h=>h.grupo===nombreGrupo).sort((a,b)=>b.fecha.localeCompare(a.fecha))[0];
  const ultDesp = aplicList.filter(a=>a.tipo==='ANTIPARASITARIO'&&(a.destino===nombreGrupo||a.grupoOrigen===nombreGrupo)).sort((a,b)=>b.fecha.localeCompare(a.fecha))[0];
  let fechaRef = null;
  if(ultHPG && ultDesp && ultDesp.fecha >= ultHPG.fecha){ fechaRef=ultDesp.fecha; }
  else if(ultHPG){ fechaRef=ultHPG.fecha; }
  if(!fechaRef) return null;
  const prox = new Date(fechaRef+'T12:00:00');
  prox.setDate(prox.getDate()+CONFIG.dias_monitoreo);
  const diasRestantes = Math.round((prox-hoy)/86400000);
  const necesitaTratar = ultHPG&&ultHPG.recomendacion==='TRATAR'&&(!ultDesp||ultDesp.fecha<ultHPG.fecha);
  return { proxFecha: prox.toISOString().split('T')[0], diasRestantes, necesitaTratar, ultHPG };
}

exports.recordatorioHPG = onSchedule({ schedule: '0 11 * * *', timeZone: 'UTC', region: 'us-central1' }, async()=>{
  const [gR,hR,aR] = await Promise.all([
    db.ref('elprado1/hacienda/grupos_resumen').once('value'),
    db.ref('elprado1/sanidad/hpg').once('value'),
    db.ref('elprado1/sanidad/aplicaciones').once('value')
  ]);
  const grupos=Object.values(gR.val()||{}).filter(Boolean);
  const hpgList=Object.values(hR.val()||{}).filter(Boolean);
  const aplicList=Object.values(aR.val()||{}).filter(Boolean);
  const hoy=new Date().toISOString().split('T')[0];
  const urgentes=[],vencidos=[],hoyList=[];
  grupos.forEach(g=>{
    const info=calcProximoMonitoreo(hpgList,aplicList,g.nombre);
    if(!info) return;
    const muestras=Math.max(6,Math.ceil((g.cabezas||0)*0.05));
    if(info.necesitaTratar) urgentes.push(Object.assign({},g,info,{muestras}));
    else if(info.proxFecha===hoy) hoyList.push(Object.assign({},g,info,{muestras}));
    else if(info.diasRestantes<0) vencidos.push(Object.assign({},g,info,{muestras}));
  });
  if(!urgentes.length&&!hoyList.length&&!vencidos.length) return null;
  let msg='EL PRADO 1 - Sanidad Animal\n' + hoy + '\n\n';
  if(urgentes.length){ msg+='TRATAMIENTO URGENTE:\n'; urgentes.forEach(g=>{ msg+='- '+g.nombre+' ('+g.cabezas+' cab.) HPG '+g.ultHPG.promedio+' EPG\n'; }); msg+='\n'; }
  if(vencidos.length){ msg+='MONITOREO VENCIDO:\n'; vencidos.forEach(g=>{ msg+='- '+g.nombre+' '+Math.abs(g.diasRestantes)+'d atrasado '+g.muestras+' muestras\n'; }); msg+='\n'; }
  if(hoyList.length){ msg+='MONITOREAR HOY:\n'; hoyList.forEach(g=>{ msg+='- '+g.nombre+' ('+g.cabezas+' cab.) '+g.muestras+' muestras\n'; }); msg+='\n'; }
  msg+='Sistema El Prado 1';
  const contactos = await getContactos();
  await enviarWhatsApp(msg, contactos);
  return null;
});

exports.alertaHPGAlto = onValueCreated({ ref: '/elprado1/sanidad/hpg/{hpgId}', region: 'us-central1' }, async(event)=>{
  const hpg=event.data.val();
  if(!hpg||hpg.recomendacion!=='TRATAR') return null;
  const msg='ALERTA HPG ALTO - EL PRADO 1\n\nGrupo: '+hpg.grupo+'\nPromedio: '+hpg.promedio+' EPG (umbral: '+hpg.umbral+')\nFecha: '+hpg.fecha+'\n\nSe recomienda tratamiento antiparasitario.';
  const contactos = await getContactos();
  await enviarWhatsApp(msg, contactos);
  return null;
});
