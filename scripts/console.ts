/** Supervises the local Observer process and its explicit restart lifecycle. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./console-server.ts', import.meta.url));
let stopping = false;
let worker: ReturnType<typeof spawn>;

function start(attachOnly = false) {
  worker = spawn(process.execPath, [entry, ...(attachOnly ? ['--attach-only'] : [])], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true,
  });
  worker.once('error', error => {
    console.error(error);
    process.exitCode = 1;
  });
  worker.once('exit', code => {
    if (code === 75 && !stopping) start(true);
    else process.exitCode = stopping ? 0 : code ?? 1;
  });
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (worker.connected) worker.send('stop', () => {});
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
start();
