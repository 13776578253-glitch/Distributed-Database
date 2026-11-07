/** Starts the standalone transaction process after recovery and owns experiment fault arming. */
import { writeSync } from 'node:fs';
import { transactionServer } from './api/http.ts';
import { openTransaction } from './storage/durable.ts';
import { faultPoints } from './storage/wal.ts';
import type { Fault } from './storage/wal.ts';

const faultsEnabled = process.env.TXN_FAULTS_ENABLED === '1';
const startupPoint = process.env.TXN_FAULT_POINT;
let armed = faultsEnabled ? faultPoints.find(point => point === startupPoint) : undefined;
if (faultsEnabled && startupPoint && !armed) throw new Error('INVALID_FAULT_POINT');

const fault: Fault = (point, record) => {
  if (point !== armed) return;
  writeSync(1, JSON.stringify({ kind: 'fault', signal: 'SIGKILL', point, record }) + '\n');
  process.kill(process.pid, 'SIGKILL');
};

const store = openTransaction(process.env.TXN_DATA_DIR ?? './txn-data', faultsEnabled ? fault : undefined);
console.log(JSON.stringify({ kind: 'recovery', ...store.recovery }));
const server = transactionServer(store, faultsEnabled ? point => { armed = point; } : undefined);
server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => {
  console.log(JSON.stringify({ kind: 'ready', address: server.address() }));
});
process.once('SIGTERM', () => server.close(() => store.close()));
