#!/usr/bin/env bash
set -euo pipefail

DATABASE="/var/lib/sambal-joelid/customer-module.sqlite"
BACKUP_DIR="/var/backups/sambal-joelid"
STAMP="$(date +%F-%H%M%S)"

install -d -m 750 "$BACKUP_DIR"
sqlite3 "$DATABASE" ".backup '$BACKUP_DIR/customer-module-$STAMP.sqlite'"
gzip -9 "$BACKUP_DIR/customer-module-$STAMP.sqlite"
find "$BACKUP_DIR" -type f -name 'customer-module-*.sqlite.gz' -mtime +14 -delete
