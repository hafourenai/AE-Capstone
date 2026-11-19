// Pintasan sesuai spesifikasi: node run-eval.js [--live] [--threshold=0.85]
import { main } from './test/eval/run.js';

main().catch((error) => { console.error(error); process.exitCode = 1; });
