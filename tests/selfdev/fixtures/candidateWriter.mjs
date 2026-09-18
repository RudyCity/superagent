import { CandidateStore } from '../../../src/core/selfdev/candidateStore.ts';
import { setTimeout as delay } from 'node:timers/promises';

const [storePath, prefix] = process.argv.slice(2);
const store = new CandidateStore({ storePath, workspace: 'concurrent', enabled: () => true });
process.once('message', async () => {
  try {
    for (let i = 0; i < 12; i++) {
      let written = false;
      for (let attempt = 0; attempt < 400; attempt++) {
        try {
          await store.create({ id: `${prefix}-${i}`, workspace: 'concurrent',
            statement: 'Verify test outcomes.', evidenceIds: [`event-${prefix}-${i}`] });
          written = true;
          break;
        } catch (error) {
          if (error.message !== 'Candidate store busy') throw error;
          await delay(5);
        }
      }
      if (!written) throw new Error('Writer retry budget exhausted');
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    process.disconnect();
  }
});
process.send('ready');
