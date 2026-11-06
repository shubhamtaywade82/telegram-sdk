# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.2.x | yes |
| < 0.2.0 | no |

## Reporting a vulnerability

This SDK implements cryptography and talks to Telegram's production
infrastructure, so security issues are treated with priority.

1. **Do not open a public issue** for suspected vulnerabilities.
2. Email the maintainer at **shubhamtaywade82@gmail.com** with details:
   - a description of the issue and its impact,
   - reproduction steps or a proof of concept,
   - affected versions/commits.
3. You will get an acknowledgement within 72 hours. Please refrain from
   public disclosure until a fix is released.

## Scope notes

- The SDK ships Telegram's **public** server RSA keys; they are not secrets.
- **Session strings and session files grant full access to the account**
  (they contain the authorization key). Treat them like passwords.
- Pre-auth input from a malicious server (pq, dh_prime, g_a) is validated
  (safe-prime checks, Miller-Rabin, range checks, iteration caps), but the
  SDK should still be pointed only at genuine Telegram datacenters.

## Hardening implemented

- DH parameter validation (known-prime list + Miller-Rabin safe-prime checks)
- Range checks on `g_a` / `g_b` / `srp_B` per the MTProto specification
- `msg_key` verification on every incoming encrypted message
- Session-id and auth-key-id checks on incoming messages
- Frame-size caps on all transports; gzip output caps and nesting limits
- Primality pre-check + iteration cap on pq factorization (hostile input)
- Atomic session-file writes
