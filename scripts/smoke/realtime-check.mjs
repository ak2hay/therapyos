// Verifies the socket.io realtime path: login, join a branch room, trigger a queue change, expect `queue.updated`.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { io } = require('socket.io-client');

const base = process.env.API_URL ?? 'http://localhost:4000';
const post = async (path, body, token) => {
  const res = await fetch(`${base}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return (await res.json()).data;
};
const get = async (path, token) => (await (await fetch(`${base}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } })).json()).data;

const login = await post('/auth/login', { identifier: 'reception@serenity.demo', password: 'Demo@12345' });
const token = login.tokens.accessToken;
const branches = await get('/branches', token);
const branch = branches.find((b) => b.code === 'IND');

const socket = io(`${base}/realtime`, { auth: { token }, transports: ['websocket'] });
const timer = setTimeout(() => {
  console.error('FAIL: no queue.updated event within 8s');
  process.exit(1);
}, 8000);
socket.on('connect', async () => {
  const ack = await socket.emitWithAck('subscribe', { branchId: branch.id });
  console.log('subscribed', ack);
  socket.once('queue.updated', async (data) => {
    console.log('received queue.updated', data);
    clearTimeout(timer);
    await post(`/queue/${entry.id}/cancel`, {}, token);
    socket.disconnect();
    process.exit(0);
  });
  var entry = await post('/queue', { branchId: branch.id, customer: { name: 'Realtime Check', phone: `+91970${String(Date.now()).slice(-7)}` } }, token);
});
socket.on('connect_error', (e) => {
  console.error('connect_error', e.message);
  process.exit(1);
});
