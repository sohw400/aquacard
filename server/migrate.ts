import { databaseFromEnvironment, type Database } from './database';
import { applyMigrations } from './migrations';
import {
  grantApplicationRole, grantAuthMailFeedbackRole, grantAuthMailRole, grantAuthorizationSimulatorRole,
  grantCardDispatcherRole, grantCardIngressRole, grantCardOperationsRole, grantCardWorkerRole,
  grantCorrectionRole, grantFundingRole, grantIssuanceRole, grantMonitorRole, grantSettlementCaseRole, grantSettlementRole,
} from './permissions';

type Grant = (database: Database, login: string) => Promise<void>;
const grants: [string, Grant][] = [];
const services: Record<string, Grant> = {
  DATABASE_RUNTIME_ROLE: grantApplicationRole,
  DATABASE_INGRESS_ROLE: grantCardIngressRole,
  DATABASE_WORKER_ROLE: grantCardWorkerRole,
  DATABASE_DISPATCHER_ROLE: grantCardDispatcherRole,
  DATABASE_OPERATIONS_ROLE: grantCardOperationsRole,
  DATABASE_AUTH_MAIL_ROLE: grantAuthMailRole,
  DATABASE_MONITOR_ROLE: grantMonitorRole,
  DATABASE_SETTLEMENT_ROLE: grantSettlementRole,
  DATABASE_FUNDING_ROLE: grantFundingRole,
  DATABASE_CORRECTION_ROLE: grantCorrectionRole,
  DATABASE_ISSUANCE_ROLE: grantIssuanceRole,
  DATABASE_AUTH_MAIL_FEEDBACK_ROLE: grantAuthMailFeedbackRole,
  DATABASE_AUTHORIZATION_SIMULATOR_ROLE: grantAuthorizationSimulatorRole,
};
for (const [variable, grant] of Object.entries(services)) {
  const login = process.env[variable];
  if (login) grants.push([login, grant]);
}
for (const login of (process.env.DATABASE_SETTLEMENT_CASE_ROLES ?? '').split(',').map(role => role.trim()).filter(Boolean)) {
  grants.push([login, grantSettlementCaseRole]);
}
if (new Set(grants.map(([login]) => login)).size !== grants.length) {
  throw new Error('The API, service workers and settlement case operators must use different database roles.');
}

const database = await databaseFromEnvironment(true);
try {
  await applyMigrations(database);
  for (const [login, grant] of grants) await grant(database, login);
  console.log('PostgreSQL migrations are up to date.');
} finally { await database.close(); }
