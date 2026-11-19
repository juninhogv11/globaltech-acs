"use strict";
// Cliente SNMP v2c mínimo (GET e WALK por GETNEXT) sobre UDP, sem dependências.
const dgram = require("dgram");

// ---------- BER ----------
function encLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  while (n > 0) { b.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), encLen(body.length), body]);
function encInt(n) {
  const b = [];
  do { b.unshift(n & 0xff); n = Math.floor(n / 256); } while (n > 0);
  if (b[0] & 0x80) b.unshift(0);
  return tlv(0x02, Buffer.from(b));
}
function encOid(oid) {
  const p = oid.replace(/^\./, "").split(".").map(Number);
  const out = [40 * p[0] + p[1]];
  for (const n of p.slice(2)) {
    const s = [n & 0x7f];
    let v = Math.floor(n / 128);
    while (v > 0) { s.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    out.push(...s);
  }
  return tlv(0x06, Buffer.from(out));
}

function decode(buf, pos = 0) {
  const tag = buf[pos];
  let len = buf[pos + 1];
  let off = pos + 2;
  if (len & 0x80) {
    const nb = len & 0x7f;
    len = 0;
    for (let i = 0; i < nb; i++) len = len * 256 + buf[off + i];
    off += nb;
  }
  return { tag, start: off, end: off + len, next: off + len };
}
function children(buf, node) {
  const out = [];
  for (let p = node.start; p < node.end;) { const c = decode(buf, p); out.push(c); p = c.next; }
  return out;
}
function decOid(b) {
  const out = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) { v = v * 128 + (b[i] & 0x7f); if (!(b[i] & 0x80)) { out.push(v); v = 0; } }
  return out.join(".");
}
function decValue(buf, n) {
  const b = buf.subarray(n.start, n.end);
  switch (n.tag) {
    case 0x02: { let v = b.length && b[0] & 0x80 ? -1 : 0; for (const x of b) v = v * 256 + x; return v; }
    case 0x04: { const s = b.toString("utf8"); return /^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(s) ? s : b.toString("hex"); }
    case 0x05: return null;
    case 0x06: return decOid(b);
    case 0x40: return [...b].join(".");
    case 0x41: case 0x42: case 0x43: case 0x46: { let v = 0; for (const x of b) v = v * 256 + x; return v; }
    case 0x80: return { erro: "noSuchObject" };
    case 0x81: return { erro: "noSuchInstance" };
    case 0x82: return { erro: "endOfMibView" };
    default: return b.toString("hex");
  }
}

let reqId = Math.floor(Math.random() * 1e6);
function request(pduTag, host, port, community, oids, timeout = 3000, tentativas = 2) {
  return new Promise((resolve, reject) => {
    const id = ++reqId % 2147483647;
    const vbs = Buffer.concat(oids.map((o) => tlv(0x30, Buffer.concat([encOid(o), Buffer.from([0x05, 0x00])]))));
    const pdu = tlv(pduTag, Buffer.concat([encInt(id), encInt(0), encInt(0), tlv(0x30, vbs)]));
    const msg = tlv(0x30, Buffer.concat([encInt(1), tlv(0x04, Buffer.from(community)), pdu]));
    const sock = dgram.createSocket(host.includes(":") ? "udp6" : "udp4");
    let n = 0, timer;
    const fim = (err, val) => { clearTimeout(timer); try { sock.close(); } catch {} err ? reject(err) : resolve(val); };
    const enviar = () => {
      if (n++ >= tentativas) return fim(new Error(`SNMP sem resposta de ${host}:${port} (community errada, porta fechada ou SNMP desligado)`));
      sock.send(msg, port, host, (e) => e && fim(e));
      timer = setTimeout(enviar, timeout);
    };
    sock.on("message", (buf) => {
      try {
        const root = decode(buf, 0);
        const [, , pduN] = children(buf, root);
        const [idN, errN, , vbN] = children(buf, pduN);
        if (decValue(buf, idN) !== id) return;
        const errStatus = decValue(buf, errN);
        if (errStatus) return fim(new Error(`SNMP erro ${errStatus}`));
        fim(null, children(buf, vbN).map((vb) => { const [o, v] = children(buf, vb); return { oid: decValue(buf, o), value: decValue(buf, v) }; }));
      } catch (e) { fim(new Error("resposta SNMP inválida: " + e.message)); }
    });
    sock.on("error", (e) => fim(e));
    enviar();
  });
}

const get = (h, p, c, oids, t) => request(0xa0, h, p, c, oids, t);

// WALK por GETNEXT até sair da árvore (limite de linhas para não travar)
async function walk(h, p, c, base, max = 5000) {
  const out = [];
  let oid = base.replace(/^\./, "");
  while (out.length < max) {
    const [vb] = await request(0xa1, h, p, c, [oid]);
    if (!vb || (vb.value && vb.value.erro) || !(vb.oid + ".").startsWith(base.replace(/^\./, "") + ".")) break;
    out.push(vb);
    oid = vb.oid;
  }
  return out;
}

module.exports = { get, walk };
