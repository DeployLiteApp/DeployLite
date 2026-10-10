import http from 'node:http';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import net from 'node:net';
import dgram from 'node:dgram';
const h=http.createServer((q,r)=>r.end('p4-healthy:'+hostname()));
h.on('upgrade',(q,s)=>{
  const accept=createHash('sha1').update(String(q.headers['sec-websocket-key'])+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  const b=Buffer.from('p4-websocket:'+hostname());s.write(Buffer.concat([Buffer.from([0x81,b.length]),b]));
  s.on('data',()=>s.end());s.on('error',()=>s.destroy());
});h.listen(3000,'0.0.0.0');
net.createServer(s=>s.on('data',b=>s.write(b))).listen(19132,'0.0.0.0');
const u=dgram.createSocket('udp4');u.on('message',(b,r)=>u.send(b,r.port,r.address));u.bind(19132,'0.0.0.0');

process.on('SIGTERM',()=>process.exit(0));
