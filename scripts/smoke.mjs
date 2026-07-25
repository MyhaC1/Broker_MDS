/** Смоук живого MDS: health → REST-снапшот → socket.io контракт FeedDriver. */
import { io } from 'socket.io-client';

const MDS = 'http://localhost:3003';
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}`); if (!ok) failures++; };

// подождать пока провайдер подключится и придут первые тики
let health;
for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch(`${MDS}/health`);
    health = await res.json();
    if (res.ok && health.provider.lastTickAt > 0) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}
check(health?.status === 'ok' && health.provider.status === 'connected', `health: provider=${health?.provider?.status}, catalog=${health?.catalog?.source} (${health?.catalog?.instruments})`);

const inst = await (await fetch(`${MDS}/v1/instruments`)).json();
check(inst.items?.length >= 5 && inst.items.every((i) => i.provider === 'binance'), `instruments: ${inst.items?.map((i) => i.symbol).join(',')}`);

const snap = await (await fetch(`${MDS}/v1/quotes?symbols=BTCUSD,ETHUSD`)).json();
const btc = snap.items?.find((q) => q.symbol === 'BTCUSD');
check(Boolean(btc && btc.price > 1000 && Number.isFinite(btc.changePercent)), `REST снапшот: BTCUSD=${btc?.price} (${btc?.changePercent}%)`);

// socket.io: контракт драйвера сайта
const socket = io(MDS, { transports: ['websocket'] });
const gotSnapshot = new Promise((resolve) => socket.once('quotes:batch', resolve));
await new Promise((resolve) => socket.on('connect', resolve));
socket.emit('subscribe', ['BTCUSD', 'ETHUSD']);
const snapshot = await Promise.race([gotSnapshot, new Promise((r) => setTimeout(() => r(null), 5000))]);
check(Array.isArray(snapshot) && snapshot.some((q) => q.symbol === 'BTCUSD'), `WS: снапшот на subscribe (${snapshot?.length} котировок)`);

// живой батч после снапшота (реальный тик Binance долетает за секунды)
const liveBatch = await Promise.race([
  new Promise((resolve) => socket.once('quotes:batch', resolve)),
  new Promise((r) => setTimeout(() => r(null), 20000)),
]);
check(Array.isArray(liveBatch) && liveBatch.every((q) => ['BTCUSD', 'ETHUSD'].includes(q.symbol)), `WS: живой батч (${liveBatch?.map((q) => `${q.symbol}=${q.price}`).join(', ')})`);

// unsubscribe: батчи по отписанным не приходят
socket.emit('unsubscribe', ['BTCUSD', 'ETHUSD']);
await new Promise((r) => setTimeout(r, 300));
const afterUnsub = await Promise.race([
  new Promise((resolve) => socket.once('quotes:batch', resolve)),
  new Promise((r) => setTimeout(() => r('silence'), 3000)),
]);
check(afterUnsub === 'silence', 'WS: после unsubscribe — тишина');

socket.close();
console.log(failures ? `\n${failures} FAILURES` : '\nALL OK');
process.exit(failures ? 1 : 0);
