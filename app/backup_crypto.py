"""
backup_crypto.py - optional password protection for backup and archive
files.

The threat this addresses is specific and real for this app: backups are
plain SQLite files that get carried out of the shop on a pendrive. A lost
or borrowed pendrive hands over every customer's name, phone number,
address, purchase history and outstanding khata balance, readable in any
free SQLite browser with no password at all.

Design:

  - AES-256-GCM. Authenticated, so a file that has been tampered with
    fails to open rather than silently decrypting to altered data. This
    matters because backups are re-imported into the live database, so a
    modified backup is a way to modify live business records.
  - Key derived with scrypt (N=2^15) from the user's password and a fresh
    random salt per file, so a weak password still costs real time and
    memory to attack offline, and two files with the same password share
    no key.
  - The KDF parameters live in the file header, so they can be raised in
    a future version without making today's files unreadable.
  - Encryption is OPT-IN. A backup saved without a password is byte-for-
    byte what this app always produced, so every existing backup, the
    .bbak double-click viewer, and any SQLite browser keep working
    exactly as before.

There is no password recovery, and that is the point: a recoverable
backup password would mean the app itself holds a way in, which is the
thing being protected against. The UI says so plainly before asking.
"""

import hashlib
import os
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"BBAKX1"
VERSION = 1

SCRYPT_N = 2 ** 15   # ~32 MB of memory per attempt
SCRYPT_R = 8
SCRYPT_P = 1
KEY_BYTES = 32
SALT_BYTES = 16
NONCE_BYTES = 12

HEADER_STRUCT_SIZE = len(MAGIC) + 1 + 4 + 2 + 2 + SALT_BYTES + NONCE_BYTES

MAX_ENCRYPTED_BYTES = 500 * 1024 * 1024


class BackupCryptoError(Exception):
    """Message is safe to show the user directly."""


def _derive_key(password, salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P):
    if not password:
        raise BackupCryptoError("A password is required to open this backup.")
    # maxmem must be raised above the default or scrypt refuses these
    # parameters outright.
    return hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=n, r=r, p=p,
        dklen=KEY_BYTES, maxmem=(128 * n * r * p) + (32 * 1024 * 1024),
    )


def is_encrypted_file(path):
    """Cheap check used to decide whether to prompt for a password."""
    try:
        with open(path, "rb") as fh:
            return fh.read(len(MAGIC)) == MAGIC
    except OSError:
        return False


def encrypt_file(plain_path, dest_path, password):
    """Encrypts plain_path to dest_path. The plaintext file is NOT
    removed here - the caller decides, so an interrupted write can never
    destroy the only copy."""
    size = os.path.getsize(plain_path)
    if size > MAX_ENCRYPTED_BYTES:
        raise BackupCryptoError("This backup is too large to password-protect.")

    with open(plain_path, "rb") as fh:
        plaintext = fh.read()

    salt = secrets.token_bytes(SALT_BYTES)
    nonce = secrets.token_bytes(NONCE_BYTES)
    key = _derive_key(password, salt)

    header = (
        MAGIC
        + bytes([VERSION])
        + SCRYPT_N.to_bytes(4, "big")
        + SCRYPT_R.to_bytes(2, "big")
        + SCRYPT_P.to_bytes(2, "big")
        + salt
        + nonce
    )

    # The header is authenticated as associated data, so the stored KDF
    # parameters cannot be swapped for weaker ones without the file
    # failing to open.
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, header)

    tmp_path = dest_path + ".part"
    try:
        with open(tmp_path, "wb") as out:
            out.write(header)
            out.write(ciphertext)
        os.replace(tmp_path, dest_path)   # atomic: never a half-written backup
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass

    return dest_path


def decrypt_to_file(src_path, dest_path, password):
    """Decrypts src_path to dest_path. Raises BackupCryptoError with a
    user-readable message on a wrong password or a tampered file - GCM
    cannot tell those two apart, so the message names both."""
    size = os.path.getsize(src_path)
    if size > MAX_ENCRYPTED_BYTES:
        raise BackupCryptoError("This backup file is too large to open.")

    with open(src_path, "rb") as fh:
        blob = fh.read()

    if len(blob) < HEADER_STRUCT_SIZE + 16 or not blob.startswith(MAGIC):
        raise BackupCryptoError("This is not a password-protected Balaji backup file.")

    pos = len(MAGIC)
    version = blob[pos]; pos += 1
    if version != VERSION:
        raise BackupCryptoError(
            "This backup was made by a newer version of the app. Please update before opening it."
        )
    n = int.from_bytes(blob[pos:pos + 4], "big"); pos += 4
    r = int.from_bytes(blob[pos:pos + 2], "big"); pos += 2
    p = int.from_bytes(blob[pos:pos + 2], "big"); pos += 2
    salt = blob[pos:pos + SALT_BYTES]; pos += SALT_BYTES
    nonce = blob[pos:pos + NONCE_BYTES]; pos += NONCE_BYTES
    header = blob[:pos]
    ciphertext = blob[pos:]

    # Refuse absurd parameters from a hostile file rather than trying to
    # allocate whatever it asks for.
    if not (2 ** 12 <= n <= 2 ** 20) or not (1 <= r <= 32) or not (1 <= p <= 16):
        raise BackupCryptoError("This backup file's header is damaged and cannot be opened.")

    key = _derive_key(password, salt, n, r, p)

    try:
        plaintext = AESGCM(key).decrypt(nonce, ciphertext, header)
    except Exception:
        raise BackupCryptoError(
            "Could not open this backup.\n\n"
            "Either the password is wrong, or the file has been damaged or altered "
            "since it was created."
        )

    if not plaintext.startswith(b"SQLite format 3\x00"):
        raise BackupCryptoError("This backup opened, but its contents are damaged.")

    tmp_path = dest_path + ".part"
    with open(tmp_path, "wb") as out:
        out.write(plaintext)
    os.replace(tmp_path, dest_path)
    return dest_path
