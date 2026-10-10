import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
http.createServer((q,r)=>r.end('p4-healthy')).listen(3000,'0.0.0.0');
net.createServer(s=>s.on('data',b=>s.write(b))).listen(19132,'0.0.0.0');
const u=dgram.createSocket('udp4');u.on('message',(b,r)=>u.send(b,r.port,r.address));u.bind(19132,'0.0.0.0');

process.on('SIGTERM',()=>process.exit(0));
