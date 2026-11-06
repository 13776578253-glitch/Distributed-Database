/** CLI entry for the same operation worker used by the web console. */
import { performOperation } from './operation-worker.ts';
const experimentId = process.argv[2];
if (experimentId !== 'R01' && experimentId !== 'R02' && experimentId !== 'R03') {
  console.error('Usage: pnpm experiment R01|R02|R03');
  process.exitCode = 1;
} else {
  try {
    const result = await performOperation({ kind: 'experiment', experimentId });
    if (result.status === 'FAIL') process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
