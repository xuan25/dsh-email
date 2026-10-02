// In-process fake SMTP server for the selftest (loopback only).
//
// Implements the SMTP surface the client exercises: greeting, EHLO (multiline
// with STARTTLS and AUTH capability lines), STARTTLS (in-place TLS upgrade on
// the same socket), AUTH LOGIN (two-step base64) and AUTH PLAIN (one-step),
// MAIL FROM / RCPT TO / DATA (dot-terminated with dot-stuffing reversal),
// NOOP / RSET / QUIT.
//
// The advertised AUTH mechanism order is configurable; the first advertised
// mechanism wins, which the client honours (matching real server negotiation).
//
// Transport branches:
//   mode 'tls'      - the connection is TLS from the start (self-signed cert)
//   mode 'starttls' - plaintext socket, upgraded to TLS on STARTTLS
//   option starttlsAdvertised (default: mode === 'starttls') set to false -
//   the EHLO response omits the STARTTLS capability and the STARTTLS command
//   is rejected: the mandatory-STARTTLS client must fail the send, never
//   degrade to plaintext
//
// Failure injection:
//   failAuth   - reject every AUTH exchange with 535 (code auth)
//   dataReject - reject the DATA transfer with a 5xx (code server)
//   protocolError - answer one command with a malformed response line, which
//                  the client's protocol layer raises as EPROTOCOL (code protocol)
//   hangGreeting - accept the connection but never send the greeting (the
//                  client budget must expire: code timeout)
//
// Recorded for assertions: the authenticated user, the envelope (MAIL FROM,
// RCPT TO list), and the DATA body bytes exactly as received on the wire
// (dot stuffing already reversed), so the selftest can compare a sent message
// against its exact MIME source.

import net from 'node:net'
import tls from 'node:tls'

import { CERT_PEM, KEY_PEM } from './test-cert.mjs'

/** One live SMTP connection: socket plus per-connection protocol state. */
function handleSmtpSocket(socket, serverState) {
  const connRecord = { authUser: null, from: null, rcpts: [], data: null, rawCommands: [] }
  serverState.connections.push(connRecord)
  let upgraded = false
  // the wire the current transport state reads and writes on: the raw socket
  // until STARTTLS upgrades it in place, the TLS socket afterwards
  let live = socket
  let inData = false
  let dataBuf = Buffer.alloc(0)
  let buf = Buffer.alloc(0)
  let stopped = false
  // AUTH exchange state (the multi-step exchanges run inside the single
  // dispatch loop so no nested socket readers race the line reader)
  let authPhase = null
  let pendingUser = null

  // Every SMTP line is CRLF-terminated on the wire; the multiline EHLO
  // body already carries its terminators, single-line responses do not.
  const send = (text) => {
    if (stopped) return
    let out = String(text)
    if (!out.endsWith('\r\n')) out += '\r\n'
    live.write(out, 'latin1')
  }

  /** The EHLO response for the current transport state. */
  function ehloResponse() {
    const lines = ['250-fake-smtp ESMTP service ready', '250-8BITMIME']
    const secureNow = serverState.mode === 'tls' || upgraded
    if (!secureNow && serverState.starttlsAdvertised !== false) lines.push('250-STARTTLS')
    if (serverState.authOrder && serverState.authOrder.length > 0) lines.push(`250-AUTH ${serverState.authOrder.join(' ')}`)
    lines.push('250 SIZE 33554432')
    return lines.join('\r\n') + '\r\n'
  }

  /** Verify one AUTH exchange (the decoded credentials). */
  function checkAuth(user, pass) {
    if (serverState.inject.failAuth || !(user in (serverState.users ?? {})) || serverState.users[user] !== pass) {
      send('535 5.7.8 Authentication credentials invalid')
      return false
    }
    connRecord.authUser = user
    send('235 2.7.0 Authentication successful')
    return true
  }

  /** Read the SMTP DATA body until the terminal dot line. */
  function handleDataBody() {
    // dot stuffing reversal: a leading dot on a content line is a single dot
    const text = dataBuf.toString('latin1')
    const end = text.indexOf('\r\n.\r\n')
    if (end === -1) return
    // the client sends the source as CRLF-terminated lines; the final
    // CRLF of the source doubles as the terminator's prefix, so a body that
    // does not end in CRLF is re-canonicalized to line-oriented form
    let body = text.slice(0, end)
    if (!body.endsWith('\r\n')) body += '\r\n'
    const unstuff = body
      .split('\r\n')
      .map((l) => (l.startsWith('..') ? l.slice(1) : l))
      .join('\r\n')
    connRecord.data = Buffer.from(unstuff, 'latin1')
    inData = false
    dataBuf = Buffer.alloc(0)
    if (serverState.inject.dataReject) {
      send('552 5.3.0 Insufficient storage - message rejected')
      return
    }
    send('250 2.0.0 Ok:<fake-message-id> Message accepted for delivery')
  }

  /**
   * Dispatch one complete line. Data-mode lines accumulate the DATA body;
   * in the middle of an AUTH exchange a line is the base64 exchange step,
   * never a command.
   */
  function dispatch(line) {
    if (inData) {
      dataBuf = Buffer.concat([dataBuf, Buffer.from(line + '\r\n', 'latin1')])
      if (line === '.') handleDataBody()
      return
    }
    // plain commands (not AUTH exchange steps) are kept in wire order so a
    // test can verify the STARTTLS-before-AUTH sequencing on the wire
    if (authPhase === null) connRecord.rawCommands.push(line.trim())
    if (authPhase === 'login-user') {
      pendingUser = Buffer.from(line.trim(), 'base64').toString('latin1')
      send('334 UGFzc3dvcmQ=')
      authPhase = 'login-pass'
      return
    }
    if (authPhase === 'login-pass') {
      const pass = Buffer.from(line.trim(), 'base64').toString('latin1')
      authPhase = null
      checkAuth(pendingUser ?? '', pass)
      return
    }
    if (authPhase === 'plain-step') {
      const decoded = Buffer.from(line.trim(), 'base64').toString('latin1')
      const parts = decoded.split('\0')
      authPhase = null
      checkAuth(parts[1] ?? '', parts[2] ?? '')
      return
    }
    const C = line.toUpperCase()
    // the trigger is a command name, or `true` to hit the first command the
    // client sends after the greeting (EHLO): a malformed line there makes the
    // client protocol layer raise EPROTOCOL
    const proto = serverState.inject.protocolError
    if (proto === true ? C.startsWith('EHLO') : typeof proto === 'string' && C.startsWith(proto)) {
      send('999 this is not a valid smtp response')
      return
    }
    if (C.startsWith('EHLO')) {
      send(ehloResponse())
    } else if (C === 'STARTTLS') {
      if (serverState.mode !== 'starttls' || upgraded || serverState.starttlsAdvertised === false) {
        send('454 4.7.0 TLS is not available on this connection')
        return
      }
      send('220 2.0.0 Ready to start TLS')
      socket.removeAllListeners('data')
      socket.pause()
      upgradeToTls(socket).then(
        (tlsSocket) => {
          upgraded = true
          live = tlsSocket
          buf = Buffer.alloc(0)
          tlsSocket.on('data', onData)
          tlsSocket.on('error', () => {})
          tlsSocket.resume()
        },
        (err) => {
          stopped = true
          socket.destroy(err)
        },
      )
    } else if (C === 'AUTH LOGIN') {
      send('334 VXNlcm5hbWU=')
      authPhase = 'login-user'
    } else if (C.startsWith('AUTH PLAIN')) {
      const arg = line.slice('AUTH PLAIN'.length).trim()
      if (arg) {
        // one-step exchange: the client folded the initial response in
        const decoded = Buffer.from(arg, 'base64').toString('latin1')
        const parts = decoded.split('\0')
        checkAuth(parts[1] ?? '', parts[2] ?? '')
      } else {
        send('334 ')
        authPhase = 'plain-step'
      }
    } else if (C.startsWith('MAIL FROM:')) {
      const m = line.match(/MAIL FROM:<([^>]*)>/i)
      if (m) connRecord.from = m[1]
      send('250 2.1.0 Sender ok')
    } else if (C.startsWith('RCPT TO:')) {
      const m = line.match(/RCPT TO:<([^>]*)>/i)
      if (m) connRecord.rcpts.push(m[1])
      send('250 2.1.5 Recipient ok')
    } else if (C === 'DATA') {
      inData = true
      dataBuf = Buffer.alloc(0)
      send('354 End data with <CR><LF>.<CR><LF>')
    } else if (C === 'NOOP') {
      send('250 2.0.0 OK')
    } else if (C === 'RSET') {
      send('250 2.0.0 Reset ok')
    } else if (C === 'QUIT') {
      send('221 2.0.0 Bye')
      stopped = true
      socket.end()
    } else {
      send('502 5.5.2 Command not recognized')
    }
  }

  /** In-place STARTTLS upgrade on the accepted socket. */
  function upgradeToTls(rawSocket) {
    return new Promise((resolve, reject) => {
      const tlsServer = tls.createServer({ cert: CERT_PEM, key: KEY_PEM, isServer: true })
      tlsServer.once('secureConnection', (s) => resolve(s))
      tlsServer.once('error', reject)
      tlsServer.emit('connection', rawSocket)
    })
  }

  function onData(data) {
    buf = Buffer.concat([buf, data])
    for (;;) {
      const idx = buf.indexOf('\n')
      if (idx === -1) return
      const line = buf.slice(0, idx).toString('latin1').replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (line.startsWith('250 ') && inData) {
        // a data line may itself start with a 250 - only the terminal dot
        // matters, so this is never a command
      }
      dispatch(line)
    }
  }

  socket.on('data', onData)
  socket.on('close', () => {
    stopped = true
  })

  if (!serverState.inject.hangGreeting) {
    send('220 fake-smtp ESMTP ready')
  }
}

/**
 * Start the fake SMTP server on loopback.
 * @param opts configuration: mode ('tls' | 'starttls'), the user map, the
 *        advertised AUTH order, and the failure injections.
 * @returns a handle with the bound port, the per-connection record list, and
 *          stop().
 */
export async function startSmtpServer(opts = {}) {
  const mode = opts.mode ?? 'tls'
  const serverState = {
    mode,
    users: opts.users ?? { agent: 'secret' },
    authOrder: opts.authOrder ?? ['PLAIN', 'LOGIN'],
    inject: opts.inject ?? {},
    connections: [],
    starttlsAdvertised: opts.starttlsAdvertised ?? mode === 'starttls',
  }
  let server
  if (mode === 'tls') {
    server = tls.createServer({ cert: CERT_PEM, key: KEY_PEM }, (socket) => handleSmtpSocket(socket, serverState))
  } else {
    server = net.createServer((socket) => handleSmtpSocket(socket, serverState))
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    port,
    state: serverState,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
