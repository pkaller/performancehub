'use strict';

// A small, offline OUI (MAC prefix -> vendor) table covering common consumer
// device makers. This is intentionally a subset — it is enough to label most
// home-network gear without shipping a multi-megabyte database or making a
// network call. Prefixes are the first 3 octets, uppercase, no separators.
const OUI = {
  // Apple
  'F0989D': 'Apple', 'A4B197': 'Apple', '3C0754': 'Apple', 'DC2B2A': 'Apple',
  'ACBC32': 'Apple', '8866A5': 'Apple', '04F7E4': 'Apple', 'F41BA1': 'Apple',
  // Google / Nest / Chromecast
  '6466B3': 'Google', 'F4F5D8': 'Google', '54600A': 'Google', '1CF29A': 'Google',
  'DA5A00': 'Google', '30FD38': 'Google', 'E4F042': 'Google Nest',
  // Amazon (Echo / Fire)
  '68F728': 'Amazon', 'FC65DE': 'Amazon', '4C1744': 'Amazon', '747548': 'Amazon',
  'AC63BE': 'Amazon', '0C47C9': 'Amazon',
  // Samsung
  '8425DB': 'Samsung', 'F0728C': 'Samsung', '5CE8EB': 'Samsung', 'BCB1F3': 'Samsung',
  // Sonos
  '5CAAFD': 'Sonos', 'B8E937': 'Sonos', '949F3E': 'Sonos', '347E5C': 'Sonos',
  // Roku
  'DC3A5E': 'Roku', 'CC6DA0': 'Roku', 'B0A737': 'Roku', 'D83134': 'Roku',
  // Raspberry Pi
  'B827EB': 'Raspberry Pi', 'DCA632': 'Raspberry Pi', 'E45F01': 'Raspberry Pi', '2CCF67': 'Raspberry Pi',
  // TP-Link / routers
  '5091E3': 'TP-Link', 'AC84C6': 'TP-Link', '54AF97': 'TP-Link',
  // Ubiquiti
  '245A4C': 'Ubiquiti', 'FCECDA': 'Ubiquiti', '788A20': 'Ubiquiti',
  // Netgear
  '9C3DCF': 'Netgear', 'A040A0': 'Netgear',
  // Espressif (ESP8266/ESP32 smart-home DIY)
  '240AC4': 'Espressif', '3C71BF': 'Espressif', '84F3EB': 'Espressif', '807D3A': 'Espressif',
  // Hikvision / Dahua (cameras)
  'C4D6A9': 'Hikvision', 'BCAD28': 'Hikvision', '3CEF8C': 'Dahua', '90022A': 'Dahua',
  // LG
  '00E091': 'LG Electronics', 'A816B2': 'LG Electronics',
  // Philips Hue
  '001788': 'Philips', 'ECB5FA': 'Philips Hue',
};

function normalizeMac(mac) {
  if (!mac) return null;
  const hex = String(mac).toUpperCase().replace(/[^0-9A-F]/g, '');
  if (hex.length < 6) return null;
  return hex;
}

function vendorForMac(mac) {
  const hex = normalizeMac(mac);
  if (!hex) return null;
  const prefix = hex.slice(0, 6);
  return OUI[prefix] || null;
}

module.exports = { vendorForMac, normalizeMac };
