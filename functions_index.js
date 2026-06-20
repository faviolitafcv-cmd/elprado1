const functions = require('firebase-functions');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

admin.initializeApp();
const db = admin.database();

// ══════════════════════════════════════════════════════════
// CONFIGURACIÓN — editá estos valores
// ══════════════════════════════════════════════════════════
const CONFIG = {
  // UltraMsg
  ultramsg_instance: 'instance181718',
  ultramsg_token: 'j51iaa51v550avsw',
  whatsapp_to: '59168753525',  // Faviola — El Prado 1

  dias_monitoreo: 14,
  hora_recordatorio: 7,
  timezone: 'America/La_Paz',
  firebase_path: 'elprado1'
};

// ══════════════════════════════════════════════════════════
// FUNCIÓN: Enviar mensaje WhatsApp via UltraMsg
// ══════════════════════════════════════════════════════════
async function enviarWhatsApp(mensaje) {
  const url = `https://api.ultramsg.com/${CONFIG.ultramsg_instance}/messages/chat`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: CONFIG.ultramsg_token,
        to: CONFIG.whatsapp_to,
        body: mensaje
      })
    });
    const data = await res.json();
    console.log('UltraMsg response:', JSON.stringify(data));
    return data;
  } catch(e) {
    console.error('Error enviando WhatsApp:', e);
    throw e;
  }
}

// ══════════════════════════════════════════════════════════
// FUNCIÓN: Calcular próximo monitoreo de un grupo
// ══════════════════════════════════════════════════════════
function calcProximoMonitoreo(hpgList, aplicList, nombreGrupo) {
  const hoy = new Date();
  hoy.setHours(0,0,0,0);

  // Último HPG del grupo
  const ultHPG = hpgList
    .filter(h => h.grupo === nombreGrupo)
    .sort((a,b) => b.fecha.localeCompare(a.fecha))[0];

  // Última desparasitación del grupo
  const ultDesp = aplicList
    .filter(a => a.tipo === 'ANTIPARASITARIO' &&
      (a.destino === nombreGrupo || a.grupoOrigen === nombreGrupo))
    .sort((a,b) => b.fecha.localeCompare(a.fecha))[0];

  // Fecha de referencia
  let fechaRef = null;
  let refTipo  = null;
  if(ultHPG && ultDesp && ultDesp.fecha >= ultHPG.fecha) {
    fechaRef = ultDesp.fecha;
    refTipo  = 'tratamiento';
  } else if(ultHPG) {
    fechaRef = ultHPG.fecha;
    refTipo  = 'hpg';
  }

  if(!fechaRef) return null;

  const fRef = new Date(fechaRef + 'T12:00:00');
  const prox = new Date(fRef);
  prox.setDate(prox.getDate() + CONFIG.dias_monitoreo);

  const diasRestantes = Math.round((prox - hoy) / 86400000);
  const necesitaTratar = ultHPG?.recomendacion === 'TRATAR' &&
    (!ultDesp || ultDesp.fecha < ultHPG.fecha);

  return {
    proxFecha: prox.toISOString().split('T')[0],
    diasRestantes,
    necesitaTratar,
    ultHPG,
    ultDesp,
    refTipo
  };
}

// ══════════════════════════════════════════════════════════
// CLOUD FUNCTION: Recordatorio diario a las 7am (Bolivia)
// Cron: cada día a las 11am UTC = 7am Bolivia (UTC-4)
// ══════════════════════════════════════════════════════════
exports.recordatorioHPG = functions
  .region('us-central1')
  .pubsub.schedule('0 11 * * *')
  .timeZone('UTC')
  .onRun(async (context) => {
    console.log('Ejecutando recordatorio HPG diario...');

    try {
      // Leer datos desde Firebase
      const [gruposSnap, hpgSnap, aplicSnap] = await Promise.all([
        db.ref(`${CONFIG.firebase_path}/hacienda/grupos_resumen`).once('value'),
        db.ref(`${CONFIG.firebase_path}/sanidad/hpg`).once('value'),
        db.ref(`${CONFIG.firebase_path}/sanidad/aplicaciones`).once('value')
      ]);

      const grupos   = Object.values(gruposSnap.val() || {}).filter(Boolean);
      const hpgList  = Object.values(hpgSnap.val()  || {}).filter(Boolean);
      const aplicList= Object.values(aplicSnap.val()|| {}).filter(Boolean);

      const hoy = new Date().toISOString().split('T')[0];

      // Grupos que tocan hoy
      const gruposHoy     = [];
      const gruposUrgentes= [];
      const gruposVencidos= [];

      grupos.forEach(g => {
        const info = calcProximoMonitoreo(hpgList, aplicList, g.nombre);
        if(!info) return;

        const muestras = Math.max(6, Math.ceil((g.cabezas||0) * 0.05));

        if(info.necesitaTratar) {
          gruposUrgentes.push({ ...g, ...info, muestras });
        } else if(info.proxFecha === hoy) {
          gruposHoy.push({ ...g, ...info, muestras });
        } else if(info.diasRestantes < 0) {
          gruposVencidos.push({ ...g, ...info, muestras });
        }
      });

      // Si no hay nada para hoy, no enviar mensaje
      if(!gruposHoy.length && !gruposUrgentes.length && !gruposVencidos.length) {
        console.log('Sin monitoreos para hoy. No se envía mensaje.');
        return null;
      }

      // Construir mensaje WhatsApp
      let msg = `🐄 *EL PRADO 1 — Sanidad Animal*\n📅 ${hoy}\n\n`;

      if(gruposUrgentes.length) {
        msg += `🔴 *TRATAMIENTO URGENTE:*\n`;
        gruposUrgentes.forEach(g => {
          msg += `• ${g.nombre} (${g.cabezas} cab.) — HPG ${g.ultHPG?.promedio} EPG\n`;
        });
        msg += '\n';
      }

      if(gruposVencidos.length) {
        msg += `🟡 *MONITOREO VENCIDO:*\n`;
        gruposVencidos.forEach(g => {
          msg += `• ${g.nombre} — ${Math.abs(g.diasRestantes)}d atrasado — ${g.muestras} muestras\n`;
        });
        msg += '\n';
      }

      if(gruposHoy.length) {
        msg += `🟢 *MONITOREAR HOY:*\n`;
        gruposHoy.forEach(g => {
          msg += `• ${g.nombre} (${g.cabezas} cab.) — ${g.muestras} muestras\n`;
        });
        msg += '\n';
      }

      msg += `_Sistema El Prado 1_`;

      console.log('Enviando WhatsApp:', msg);
      await enviarWhatsApp(msg);
      console.log('Mensaje enviado exitosamente.');

    } catch(e) {
      console.error('Error en recordatorioHPG:', e);
    }

    return null;
  });

// ══════════════════════════════════════════════════════════
// CLOUD FUNCTION: Alerta inmediata cuando se registra HPG alto
// Se dispara cuando se escribe en sanidad/hpg
// ══════════════════════════════════════════════════════════
exports.alertaHPGAlto = functions
  .region('us-central1')
  .database.ref(`${CONFIG.firebase_path}/sanidad/hpg/{hpgId}`)
  .onCreate(async (snapshot, context) => {
    const hpg = snapshot.val();
    if(!hpg || hpg.recomendacion !== 'TRATAR') return null;

    console.log('HPG alto detectado para grupo:', hpg.grupo);

    const msg =
      `🔴 *ALERTA HPG ALTO — EL PRADO 1*\n\n` +
      `🐄 Grupo: *${hpg.grupo}*\n` +
      `📊 Promedio: *${hpg.promedio} EPG* (umbral: ${hpg.umbral})\n` +
      `📅 Fecha muestreo: ${hpg.fecha}\n` +
      `👩‍⚕️ Operador: ${hpg.operador || hpg.usuario || '—'}\n\n` +
      `⚠️ *Se recomienda tratamiento antiparasitario.*\n` +
      `_Ingresá al sistema para registrar el tratamiento._`;

    try {
      await enviarWhatsApp(msg);
      console.log('Alerta HPG alto enviada.');
    } catch(e) {
      console.error('Error enviando alerta:', e);
    }

    return null;
  });
