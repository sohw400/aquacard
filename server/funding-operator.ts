import { LedgerError } from './errors';
import { FundingStore } from './funding-store';
import { cardServiceDatabase } from './card-service-database';
import { verifyFundingRole } from './permissions';
import { verifyMigrations } from './migrations';

// Read one normalized provider event from stdin so scripts can preserve its exact retry identity.
async function run() {
  if (process.argv.length!==2 || process.stdin.isTTY || process.env.NODE_ENV==='production') {
    throw new Error('Disabled or invalid invocation');
  }
  const chunks: Buffer[]=[];
  let size=0;
  for await (const chunk of process.stdin) {
    const bytes=Buffer.from(chunk);
    size+=bytes.length;
    if(size>4096) throw new Error('Invalid event');
    chunks.push(bytes);
  }
  const input:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  if (!input || typeof input!=='object' || Array.isArray(input)) throw new Error('Invalid event');
  const db=await cardServiceDatabase('funding');
  try {
    await verifyMigrations(db); await verifyFundingRole(db);
    console.log(JSON.stringify(await new FundingStore(db).event(input as Record<string,unknown>)));
  } finally { await db.close(); }
}
run().catch((error:unknown)=>{
  console.error(error instanceof LedgerError ? error.code : 'Sandbox funding event unavailable. Supply a single JSON event on stdin using the dedicated funding login.');
  process.exitCode=1;
});
