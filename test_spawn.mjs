import { spawn } from 'child_process';
const p = spawn(process.execPath, ['--experimental-require-module', '-e', 'console.log("child works", process.execArgv)'], { stdio: 'inherit' });
p.on('exit', (c) => console.log('exited with', c));
