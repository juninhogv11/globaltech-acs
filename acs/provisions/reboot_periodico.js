/*
  Reboot periódico (preset 06_REBOOT_PERIODICO, a cada inform periódico)

  Reinicia o equipamento que está ligado há 48 horas ou mais, só de madrugada,
  para evitar travamentos.

  - Janela: das 03:00 às 05:00 (horário de Brasília, UTC-3).
  - Cada equipamento tem um minuto próprio dentro da janela, calculado pelo ID dele,
    para não reiniciarem todos ao mesmo tempo (evita pico de reconexões no PPPoE/OLT).
  - Não reinicia de novo se já recebeu um reboot do ACS nas últimas 20 horas
    (proteção caso algum modelo não zere o UpTime).
  - Para tirar um equipamento do reboot automático: tag SEM_REBOOT (preset não roda).
*/
const UPTIME_MIN = 48 * 3600;   // 48 horas, em segundos
const JANELA_INICIO = 3;        // 03:00
const JANELA_MINUTOS = 120;     // até 05:00
const FUSO_HORAS = -3;          // Brasília
const INTERVALO_MIN_REBOOT = 20 * 3600 * 1000;

const now = Date.now();

// Hora local (Brasil sem horário de verão desde 2019)
const local = new Date(now + FUSO_HORAS * 3600000);
const minutoDoDia = local.getUTCHours() * 60 + local.getUTCMinutes();
const minutoNaJanela = minutoDoDia - JANELA_INICIO * 60;

if (minutoNaJanela >= 0 && minutoNaJanela < JANELA_MINUTOS) {
  // Minuto reservado deste equipamento dentro da janela (0..119)
  const idObj = declare("DeviceID.ID", {value: 1});
  const id = (idObj && idObj.value) ? String(idObj.value[0]) : "";
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 1000003;
  const slot = h % JANELA_MINUTOS;

  if (minutoNaJanela >= slot) {
    // Mesmo critério das outras provisions para escolher TR-098 ou TR-181
    const TR181_MODELS = ["XX530v"];
    const pcObj = declare("DeviceID.ProductClass", {value: 1});
    const isTr181Model = TR181_MODELS.indexOf((pcObj && pcObj.value) ? String(pcObj.value[0]) : "") >= 0;
    const isIGD = declare("InternetGatewayDevice.DeviceInfo.HardwareVersion", {value: 1}).size > 0 && !isTr181Model;
    const upPath = isIGD ? "InternetGatewayDevice.DeviceInfo.UpTime" : "Device.DeviceInfo.UpTime";

    // Lê o UpTime atualizado (no máximo 5 minutos de idade)
    const upObj = declare(upPath, {value: now - 300000});
    const uptime = (upObj && upObj.value) ? Number(upObj.value[0]) : NaN;

    // Último reboot pedido pelo ACS (0 se nunca)
    const rbObj = declare("Reboot", {value: 1});
    const ultimoReboot = (rbObj && rbObj.value && rbObj.value[0]) ? new Date(rbObj.value[0]).getTime() : 0;

    if (uptime >= UPTIME_MIN && now - ultimoReboot > INTERVALO_MIN_REBOOT) {
      log("REBOOT_PERIODICO " + id + " uptime=" + Math.round(uptime / 3600) + "h");
      declare("Reboot", null, {value: now});
    }
  }
}
