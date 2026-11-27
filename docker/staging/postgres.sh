#!/bin/sh
set -eu
install -d -m 0700 -o postgres -g postgres /run/aqua-tls
install -m 0600 -o postgres -g postgres /run/aqua-source/db.key /run/aqua-tls/db.key
install -m 0644 -o postgres -g postgres /run/aqua-source/db.crt /run/aqua-tls/db.crt
install -m 0644 -o postgres -g postgres /etc/aqua-pg-hba.conf /run/aqua-tls/pg_hba.conf
exec docker-entrypoint.sh postgres -c ssl=on -c ssl_min_protocol_version=TLSv1.2 \
  -c ssl_cert_file=/run/aqua-tls/db.crt -c ssl_key_file=/run/aqua-tls/db.key \
  -c hba_file=/run/aqua-tls/pg_hba.conf
