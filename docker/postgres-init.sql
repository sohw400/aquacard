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
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aqua_auth_mail') THEN
    CREATE ROLE aqua_auth_mail LOGIN PASSWORD 'aqua_auth_mail_local_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$bootstrap$;
