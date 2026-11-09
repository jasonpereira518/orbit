#!/usr/bin/env bash
# ==============================================================================
# Orbit Production Database Backup Script
#
# Creates an encrypted, verified logical backup of the production Neon PostgreSQL database.
# Suitable for automated execution via GitHub Actions or cron.
#
# Environment variables:
#   DATABASE_URL: PostgreSQL connection string (required)
#   BACKUP_DIR: Local directory to store dump artifacts (default: ./backups)
#   BACKUP_ENCRYPTION_KEY: Encryption passphrase / public key (optional)
# ==============================================================================

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "${BACKUP_DIR}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "Error: DATABASE_URL is not set" >&2
  exit 1
fi

TIMESTAMP=$(date -u +"%Y%m%d_%H%M%SZ")
RAW_DUMP="${BACKUP_DIR}/orbit_backup_${TIMESTAMP}.dump"
FINAL_DUMP="${RAW_DUMP}"

echo "[$(date -u)] Starting logical database backup..."

# 1. Execute pg_dump using directory/custom format with max compression
# Exclude ephemeral session and lock tables that should not be restored
pg_dump "${DATABASE_URL}" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --exclude-table-data="schema_migration_lock" \
  --file="${RAW_DUMP}"

DUMP_SIZE=$(wc -c < "${RAW_DUMP}" | tr -d ' ')
echo "[$(date -u)] pg_dump complete: ${RAW_DUMP} (${DUMP_SIZE} bytes)"

# 2. Verify dump header integrity using pg_restore list
echo "[$(date -u)] Verifying dump integrity with pg_restore --list..."
pg_restore --list "${RAW_DUMP}" > /dev/null
echo "[$(date -u)] Dump header verification passed."

# 3. Encrypt dump if BACKUP_ENCRYPTION_KEY is provided
if [ -n "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  ENCRYPTED_DUMP="${RAW_DUMP}.enc"
  echo "[$(date -u)] Encrypting backup with OpenSSL AES-256-CBC..."
  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 100000 \
    -in "${RAW_DUMP}" \
    -out "${ENCRYPTED_DUMP}" \
    -pass env:BACKUP_ENCRYPTION_KEY
  rm -f "${RAW_DUMP}"
  FINAL_DUMP="${ENCRYPTED_DUMP}"
  echo "[$(date -u)] Encryption complete: ${FINAL_DUMP}"
fi

# 4. Generate SHA256 checksum for audit trail
CHECKSUM_FILE="${FINAL_DUMP}.sha256"
shasum -a 256 "${FINAL_DUMP}" > "${CHECKSUM_FILE}"
echo "[$(date -u)] Checksum: $(cat "${CHECKSUM_FILE}")"
echo "[$(date -u)] Backup finished successfully."
