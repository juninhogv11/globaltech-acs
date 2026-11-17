const hourly = Date.now() - 3600000;
const every_ten_minutes = Date.now() - 600000;
const now = Date.now();

// ==========================================
// 1. IDENTIFICAÇÃO SEGURA DO MODELO (SEM SYMBOL ERROR)
// ==========================================
let devType = declare("DeviceID.ProductClass", {value: 1});
let isIGD = false;

// Modelos TR-181 que também respondem pelo TR-098 (ex.: TPLG1507E7F0): seguem o caminho TR-181
const TR181_MODELS = ["XX530v"];
const pcObj = declare("DeviceID.ProductClass", {value: 1});
const isTr181Model = TR181_MODELS.indexOf((pcObj && pcObj.value) ? String(pcObj.value[0]) : "") >= 0;
let igdCheck = declare("InternetGatewayDevice.DeviceInfo.HardwareVersion", {value: 1});
if (igdCheck && igdCheck.value !== undefined && !isTr181Model) {
  isIGD = true;
}

// ==========================================
// 2. FORÇAR COMUNICAÇÃO CWMP VIA IPv4
// ==========================================
const ACS_URL = "{{ACS_URL}}";
if (isIGD) {
  declare("InternetGatewayDevice.ManagementServer.URL", {value: hourly}, {value: ACS_URL});
} else {
  declare("Device.ManagementServer.URL", {value: hourly}, {value: ACS_URL});
}

// ==========================================
// 3. CREDENCIAIS CONNECTION REQUEST (SUMMON)
// ==========================================
const CR_USER = "{{CR_USER}}";
const CR_PASS = "{{CR_PASS}}";

if (isIGD) {
  declare("InternetGatewayDevice.ManagementServer.ConnectionRequestUsername", {value: hourly}, {value: CR_USER});
  declare("InternetGatewayDevice.ManagementServer.ConnectionRequestPassword", {value: hourly}, {value: CR_PASS});
} else {
  declare("Device.ManagementServer.ConnectionRequestUsername", {value: hourly}, {value: CR_USER});
  declare("Device.ManagementServer.ConnectionRequestPassword", {value: hourly}, {value: CR_PASS});
}

// ==========================================
// 4. LEITURA PERIÓDICA TR-098 (IGD)
// ==========================================
if (isIGD) {
  declare("InternetGatewayDevice.DeviceInfo.HardwareVersion", {path: hourly, value: hourly});
  declare("InternetGatewayDevice.DeviceInfo.SoftwareVersion", {path: hourly, value: hourly});
  declare("InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.MACAddress", {path: hourly, value: hourly});
  declare("InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.ExternalIPAddress", {path: every_ten_minutes, value: every_ten_minutes});
  declare("InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.ExternalIPAddress", {path: every_ten_minutes, value: every_ten_minutes});
  declare("InternetGatewayDevice.LANDevice.*.LANHostConfigManagement.IPInterface.1.IPInterfaceIPAddress", {path: hourly, value: hourly});
  declare("InternetGatewayDevice.LANDevice.*.WLANConfiguration.*.SSID", {path: hourly, value: hourly});
  declare("InternetGatewayDevice.LANDevice.*.WLANConfiguration.*.X_TP_PreSharedKey", {path: every_ten_minutes, value: 1});
  declare("InternetGatewayDevice.LANDevice.*.Hosts.Host.*.HostName", {path: every_ten_minutes, value: every_ten_minutes});
  declare("InternetGatewayDevice.LANDevice.*.Hosts.Host.*.IPAddress", {path: every_ten_minutes, value: every_ten_minutes});
  declare("InternetGatewayDevice.LANDevice.*.Hosts.Host.*.MACAddress", {path: every_ten_minutes, value: every_ten_minutes});
} else {
  // ==========================================
  // 5. LEITURA PERIÓDICA TR-181 (XX530v)
  // ==========================================
  declare("Device.DeviceInfo.HardwareVersion", {path: every_ten_minutes, value: every_ten_minutes});
  declare("Device.DeviceInfo.SoftwareVersion", {path: every_ten_minutes, value: every_ten_minutes});
  declare("Device.DeviceInfo.ProductClass", {path: every_ten_minutes, value: every_ten_minutes});
  declare("Device.DeviceInfo.SerialNumber", {path: every_ten_minutes, value: every_ten_minutes});
  declare("Device.Ethernet.Interface.*.MACAddress", {path: every_ten_minutes, value: every_ten_minutes});
  declare("Device.IP.Interface.*.IPv4Address.*.IPAddress", {path: every_ten_minutes, value: every_ten_minutes});
  declare("Device.PPP.Interface.*.ExternalIPAddress", {path: every_ten_minutes, value: every_ten_minutes});
  declare("Device.WiFi.SSID.*.SSID", {path: every_ten_minutes, value: every_ten_minutes});
  declare("Device.WiFi.AccessPoint.*.Security.KeyPassphrase", {path: every_ten_minutes, value: every_ten_minutes});
  declare("Device.Hosts.Host.*.HostName", {path: every_ten_minutes, value: every_ten_minutes});
  declare("Device.Hosts.Host.*.IPAddress", {path: every_ten_minutes, value: every_ten_minutes});
  declare("Device.Hosts.Host.*.MACAddress", {path: every_ten_minutes, value: every_ten_minutes});
  declare("Device.Hosts.Host.*.Active", {path: every_ten_minutes, value: every_ten_minutes});

  // Sinal óptico GPON (TP-Link XX530v) para o portal
  declare("Device.Optical.Interface.*.X_TP_GPON_Config.RXPower", {path: hourly, value: every_ten_minutes});
  declare("Device.Optical.Interface.*.X_TP_GPON_Config.TXPower", {path: hourly, value: every_ten_minutes});
}

// ==========================================
// 6. ATUALIZAÇÃO DOS VIRTUAL PARAMETERS
// ==========================================
declare("VirtualParameters.HardwareVersion", {value: 1});
declare("VirtualParameters.SoftwareVersion", {value: 1});
declare("VirtualParameters.MAC", {value: 1});
declare("VirtualParameters.WANIP", {value: every_ten_minutes});
declare("VirtualParameters.IP", {value: every_ten_minutes});
declare("VirtualParameters.LANIP", {value: 1});
declare("VirtualParameters.SSID24", {value: 1});
declare("VirtualParameters.SSID58", {value: 1});
declare("VirtualParameters.SpeedTestResult", {value: 1});