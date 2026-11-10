const informInterval = 300;
const NTPServer = "{{NTP_SERVER}}";
const TimeZone = "-03:00";
const daily = Date.now() - 86400000;

// Obtém Device ID
const devId = declare("DeviceID.ID", {value: 1});
const username = (devId && devId.value && devId.value[0]) ? devId.value[0] : "";
const password = Math.trunc(Math.random() * Number.MAX_SAFE_INTEGER).toString(36);

// Identifica se o equipamento responde por TR-098 (IGD) ou TR-181 (Device)
// Modelos TR-181 que também respondem pelo TR-098 (ex.: TPLG1507E7F0): seguem o caminho TR-181
const TR181_MODELS = ["XX530v"];
const pcObj = declare("DeviceID.ProductClass", {value: 1});
const isTr181Model = TR181_MODELS.indexOf((pcObj && pcObj.value) ? String(pcObj.value[0]) : "") >= 0;
const isIGD = declare("InternetGatewayDevice.DeviceInfo.HardwareVersion", {value: 1}).size > 0 && !isTr181Model;

if (isIGD) {
  // ==========================
  // CONFIGURAÇÃO TR-098 (IGD)
  // ==========================
  declare("InternetGatewayDevice.ManagementServer.ConnectionRequestUsername", {value: daily}, {value: username});
  declare("InternetGatewayDevice.ManagementServer.ConnectionRequestPassword", {value: daily}, {value: password});
  declare("InternetGatewayDevice.ManagementServer.PeriodicInformEnable", {value: daily}, {value: true});
  declare("InternetGatewayDevice.ManagementServer.PeriodicInformInterval", {value: daily}, {value: informInterval});

  declare("InternetGatewayDevice.Time.Enable", {value: daily}, {value: true});
  declare("InternetGatewayDevice.Time.NTPServer1", {value: daily}, {value: NTPServer});
  declare("InternetGatewayDevice.Time.LocalTimeZone", {value: daily}, {value: TimeZone});

  // Atualiza a estrutura da árvore TR-098 diariamente
  declare("InternetGatewayDevice", {path: daily});
} else {
  // ==========================
  // CONFIGURAÇÃO TR-181 (XX530v)
  // ==========================
  // Tipagem estrita para evitar o fault 9006 da TP-Link
  declare("Device.ManagementServer.PeriodicInformEnable", {value: daily}, {value: [true, "xsd:boolean"]});
  declare("Device.ManagementServer.PeriodicInformInterval", {value: daily}, {value: [informInterval, "xsd:unsignedInt"]});

  if (username) {
    declare("Device.ManagementServer.ConnectionRequestUsername", {value: daily}, {value: [username, "xsd:string"]});
    declare("Device.ManagementServer.ConnectionRequestPassword", {value: daily}, {value: [password, "xsd:string"]});
  }

  // NTP para TR-181 (sem a chave Device.Time.Enable que a TP-Link rejeita)
  declare("Device.Time.NTPServer1", {value: daily}, {value: [NTPServer, "xsd:string"]});
  declare("Device.Time.LocalTimeZone", {value: daily}, {value: [TimeZone, "xsd:string"]});

  // Atualiza a estrutura da árvore TR-181 diariamente
  declare("Device", {path: daily});
}