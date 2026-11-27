-- Local development and CI only. Production roles and credentials are provisioned separately.
-- Preserve an existing role and its credentials when this bootstrap is invoked again.
DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aqua_app') THEN
    CREATE ROLE aqua_app LOGIN PASSWORD 'aqua_app_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aqua_worker') THEN
    CREATE ROLE aqua_worker LOGIN PASSWORD 'aqua_worker_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aqua_ingress') THEN
    CREATE ROLE aqua_ingress LOGIN PASSWORD 'aqua_ingress_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aqua_dispatcher') THEN
    CREATE ROLE aqua_dispatcher LOGIN PASSWORD 'aqua_dispatcher_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aqua_operations') THEN
    CREATE ROLE aqua_operations LOGIN PASSWORD 'aqua_operations_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aqua_settlement') THEN
    CREATE ROLE aqua_settlement LOGIN PASSWORD 'aqua_settlement_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aqua_funding') THEN
    CREATE ROLE aqua_funding LOGIN PASSWORD 'aqua_funding_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aqua_correction') THEN
    CREATE ROLE aqua_correction LOGIN PASSWORD 'aqua_correction_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aqua_issuance') THEN
    CREATE ROLE aqua_issuance LOGIN PASSWORD 'aqua_issuance_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aqua_feedback') THEN
    CREATE ROLE aqua_feedback LOGIN PASSWORD 'aqua_feedback_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aqua_authorizer') THEN
    CREATE ROLE aqua_authorizer LOGIN PASSWORD 'aqua_authorizer_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aqua_case_analyst') THEN
    CREATE ROLE aqua_case_analyst LOGIN PASSWORD 'aqua_case_analyst_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aqua_case_reviewer') THEN
    CREATE ROLE aqua_case_reviewer LOGIN PASSWORD 'aqua_case_reviewer_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aqua_monitor') THEN
    CREATE ROLE aqua_monitor LOGIN PASSWORD 'aqua_monitor_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aqua_auth_mail') THEN
    CREATE ROLE aqua_auth_mail LOGIN PASSWORD 'aqua_auth_mail_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$bootstrap$;
