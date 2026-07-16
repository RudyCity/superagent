import fs from 'fs';

const checkpointPath = 'C:\\Users\\USER\\.superagent-r\\history\\single\\D__backup_from_pc_asus_Documents_Development_superagent_1784127919317\\checkpoints\\checkpoint_1784167077780.json';
const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));

console.log('Checkpoint keys:', Object.keys(checkpoint));
if (checkpoint.planState) console.log('Plan State:', checkpoint.planState);
if (checkpoint.history) {
  console.log('History keys:', Object.keys(checkpoint.history));
  console.log('Messages count:', checkpoint.history.messages?.length);
}
