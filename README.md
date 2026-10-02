# dsh-email

dsh-email gives a DSH agent working access to a mailbox: the `email` tool reads and sends the user's mail over standard IMAP/SMTP, so the agent can check and answer it with only a password or app-specific password.

- Read and search mail: list, unread view, structured search, read without marking seen
- Verify account health: verify checks every configured account live (IMAP login + SMTP authentication) with zero side effects
- Send, reply, forward - with attachments
- Manage mailboxes: create and delete folders, move messages
- Multiple accounts in one plugin
- Deletion is per-account gated: delete and delete_folder run only on accounts that opt in
- Stateless: one fresh connection per call

## Installation

dsh-email is an out-of-tree plugin for a dsh profile. Install it with the dsh plugin command:

```sh
dsh plugin --profile <name> add dsh-email
```

Configuration is environment plus an optional config layer from a cordis patch file (both below); the plugin creates no files.

## Configuration

The base configuration is environment; env changes take effect on a host restart. One account needs four variables, the rest are optional:

| Variable | Required | Meaning |
|---|---|---|
| `EMAIL_<N>_USER` | yes | login name shared by IMAP and SMTP (usually the mailbox address) |
| `EMAIL_<N>_PASS` | yes | password or the provider's app-specific password / auth code |
| `EMAIL_<N>_IMAP_HOST` | yes | IMAP server host |
| `EMAIL_<N>_IMAP_PORT` | no | IMAP port, default 993 |
| `EMAIL_<N>_IMAP_SECURE` | no | IMAP TLS mode: `tls` = implicit TLS / `starttls` = mandatory STARTTLS upgrade / `none` = full plaintext, no STARTTLS attempted; default `tls` |
| `EMAIL_<N>_IMAP_ALLOW_INSECURE_TLS` | no | certificate validation: `false` = strict (default) / `true` = accept untrusted / self-signed certificates (only meaningful with the `tls` / `starttls` modes) |
| `EMAIL_<N>_SMTP_HOST` | yes | SMTP server host |
| `EMAIL_<N>_SMTP_PORT` | no | SMTP port, default 587 |
| `EMAIL_<N>_SMTP_SECURE` | no | SMTP TLS mode: the same three values as the IMAP side; default `starttls` |
| `EMAIL_<N>_SMTP_ALLOW_INSECURE_TLS` | no | same as the IMAP side |
| `EMAIL_<N>_FROM` | no | sender address, default = `EMAIL_<N>_USER` |
| `EMAIL_<N>_FROM_NAME` | no | sender display name |
| `EMAIL_<N>_SENT_FOLDER` | no | when set, sends also copy the sent message into this folder |
| `EMAIL_<N>_SENT_FOLDER_AUTOCREATE` | no | default `true`: when the SENT_FOLDER copy fails because the folder is missing, create it (the exact name INBOX is never created) and retry once; `false` = never create |
| `EMAIL_<N>_ALLOW_DELETE` | no | default `false` (fail-closed): the gate for the `delete` and `delete_folder` verbs on this account; `true` = the agent may delete messages and mailboxes on it |
| `EMAIL_<N>_TIMEOUT_MS` | no | per-call timeout budget, default 120000 |
| `EMAIL_DEFAULT_ACCOUNT` | no | the account used when a call names no account |
| `EMAIL_READ_BODY_LIMIT` | no | read body truncation budget in characters, default 20000 |

The `<N>` segment is the account name uppercased; the account name must match `^[a-z][a-z0-9-]{0,31}$`. Accounts missing any required variable are dropped with a boot warning (boot never fails). Multiple accounts are supported.

Example:

```
EMAIL_DEFAULT_ACCOUNT=local
EMAIL_LOCAL_USER=agent@local.example
EMAIL_LOCAL_PASS=<credential>
EMAIL_LOCAL_IMAP_HOST=mail.local.example
EMAIL_LOCAL_SMTP_HOST=mail.local.example
EMAIL_LOCAL_SENT_FOLDER=Sent
```

### Config layer (cordis patch)

An optional config layer sits on top of the env block: a patch entry targeting the plugin id `dsh-email` (the profile's `cordis.patch.yml`, the user-global `~/.dsh/cordis.patch.yml`, or a `--patch` overlay) carries a `config` object whose keys are camelCase mirrors of the env fields - `defaultAccount`, `readBodyLimit`, and `accounts` (a map of account name to `user`, `pass`, `imapHost`, `imapPort`, `imapSecure`, `imapAllowInsecureTls`, `smtpHost`, `smtpPort`, `smtpSecure`, `smtpAllowInsecureTls`, `from`, `fromName`, `sentFolder`, `sentFolderAutocreate`, `allowDelete`, `timeoutMs`). Every key is optional.

```yaml
- id: dsh-email
  config:
    readBodyLimit: 500
    accounts:
      default:
        imapPort: 1043
```

- One precedence chain: delivered value > env value > built-in default; keys the layer omits resolve as the env block, so `config: {}` (or no entry) is exactly the env-only behavior.
- A patch targets a row by id and replaces its whole config - no deep merge, so a layer that overrides one field restates the fields it keeps (layer order: the plugin's own default entry, the profile patch, the user-global patch, any `--patch` overlay).
- The layer is validated before the plugin starts: an unknown key or an out-of-range value fails the plugin entry at load; incomplete account data only warns, as in the env block.
- With the live patch reload, editing the patch file re-runs the plugin without a restart; otherwise the change applies at the next restart.
- The agent edits the patch file as a plain file operation under its own permissions; the plugin provides no tool for changing its own configuration. The `accounts` verb shows values only.

## Usage

The plugin adds the `email` tool and the `dsh-email` skill (verb reference, env contract details, limits, troubleshooting). The sixteen verbs, one line each:

```
email { verb: "accounts" }                                  # configured accounts (local, no network)
email { verb: "verify" }                                    # live connectivity + credentials, zero side effects
email { verb: "folders" }                                    # mailbox names
email { verb: "list", flagged: true }                       # newest-first summaries, flagged only
email { verb: "list_unseen" }                                # the unread view
email { verb: "search", since: "2026-10-01", subject: "ci" } # structured criteria
email { verb: "read", uid: 42 }                              # parts + body (PEEK: does not mark seen)
email { verb: "mark", uids: [42], seen: true }               # set/clear seen and flagged
email { verb: "save_part", uid: 42, part: 1 }                # write one part to disk
email { verb: "send", to: "a@b.c", subject: "hi", text: "..." }  # plus html / attachments / cc / bcc
email { verb: "reply", uid: 42, text: "thanks" }             # quotes the original by default
email { verb: "forward", uid: 42, to: "d@e.f" }              # includes the original by default
email { verb: "create_folder", folder: "Archive" }           # idempotent; INBOX is reserved
email { verb: "move", folder: "INBOX", dest: "Archive", uids: [42] } # dest must exist; not gated
email { verb: "delete", uids: [42] }                         # gated: EMAIL_<N>_ALLOW_DELETE
email { verb: "delete_folder", folder: "Archive" }           # gated: EMAIL_<N>_ALLOW_DELETE
```

Reads never change server-side flags; `mark` is the only way to write flags. Failures carry an error code for transport origins (`auth` / `network` / `tls` / `timeout` / `protocol` / `server`); local validation errors carry none.

## Limits and boundaries

- Stateless: one fresh connection per call; no IDLE/push, no connection pooling.
- No subscribe/unsubscribe verbs, no folder management beyond create/delete; no XOAUTH2 (password / app-specific password only).
- `delete` and `delete_folder` are fail-closed: they run only on accounts with `EMAIL_<N>_ALLOW_DELETE=true`; `move` is ungated because a failed source-side deletion leaves the copies in the destination.
- Read bodies are truncated to the configured budget; `save_part` retrieves full parts.
- Sent messages are not recalled; a SENT_FOLDER copy that fails on a missing folder first tries to create it (unless `EMAIL_<N>_SENT_FOLDER_AUTOCREATE=false` or the folder is exactly INBOX), then retries once; a copy failure that survives that is reported without rolling back the delivered message.
