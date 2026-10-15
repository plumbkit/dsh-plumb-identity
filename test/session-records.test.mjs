// Reading plumb's session records (test/session-records.mjs), PLAN-520 slice C.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  E2E_CLIENT_NAMES, inNamespace, isRecordFile, logLinesForSessions, parseSessionRecord, readRecordsIn, readRecordsUnder, strayRecords,
} from './session-records.mjs'

/** A session file the way plumb writes it (Go's encoding/json: a zero ended_at is the year 1). */
function sessionFile(fields) {
  return JSON.stringify({
    id: 'a1', pid: 4242, language: 'go', folder: '/w', adapter: 'gopls',
    started_at: '2026-10-15T20:00:00.5+11:00', ended_at: '0001-01-01T00:00:00Z',
    ...fields,
  })
}

test('parseSessionRecord: the fields the assertions use', () => {
  const record = parseSessionRecord(sessionFile({
    id: 's1', name: 'calm-fox', client_name: 'dsh-plumb-identity', external_id: 'dsh-workspace-abcdef-session-1234', purpose: 'dsh',
    namespace: 'ns-1a2b3c4d', health: 'shared_connection_detected',
  }), '/x/s1.json')
  assert.equal(record.id, 's1')
  assert.equal(record.name, 'calm-fox')
  assert.equal(record.clientName, 'dsh-plumb-identity')
  assert.equal(record.externalId, 'dsh-workspace-abcdef-session-1234')
  assert.equal(record.purpose, 'dsh')
  assert.equal(record.isIdentity, true)
  assert.equal(record.namespace, 'ns-1a2b3c4d')
  assert.equal(record.health, 'shared_connection_detected')
  assert.equal(record.ended, false)
  assert.equal(record.startedAtMs, Date.parse('2026-10-15T20:00:00.5+11:00'))
  assert.equal(record.file, '/x/s1.json')
})

test('parseSessionRecord: the default namespace has no namespace field, and is the empty id', () => {
  assert.equal(parseSessionRecord(sessionFile({ client_name: 'x' })).namespace, '')
})

test('parseSessionRecord: only a real timestamp is an end', () => {
  assert.equal(parseSessionRecord(sessionFile({ client_name: 'x', ended_at: '0001-01-01T00:00:00Z' })).ended, false)
  assert.equal(parseSessionRecord(sessionFile({ client_name: 'x', ended_at: '2026-10-15T20:01:00Z' })).ended, true)
  assert.equal(parseSessionRecord(sessionFile({ client_name: 'x', ended_at: undefined })).ended, false)
})

test('parseSessionRecord: an id that is not a minted identity is not one', () => {
  assert.equal(parseSessionRecord(sessionFile({ external_id: 'typed-by-model' })).isIdentity, false)
  assert.equal(parseSessionRecord(sessionFile({ external_id: 'dsh-short' })).isIdentity, false)
})

test('parseSessionRecord: half-written, non-object and field-less text is no record', () => {
  assert.equal(parseSessionRecord('{"id": "a'), null, 'half-written JSON')
  assert.equal(parseSessionRecord('null'), null)
  assert.equal(parseSessionRecord('[]'), null)
  assert.equal(parseSessionRecord('"text"'), null)
  assert.equal(parseSessionRecord(JSON.stringify({ id: 'a1', pid: 1 })), null, 'none of external_id, purpose, client_name')
})

test('isRecordFile: plumb\'s temp files are not records', () => {
  assert.equal(isRecordFile('abc.json'), true)
  assert.equal(isRecordFile('.session-123.json.tmp'), false)
  assert.equal(isRecordFile('.hidden.json'), false)
  assert.equal(isRecordFile('abc.json.tmp'), false)
  assert.equal(isRecordFile('.sessions.lock'), false)
})

test('readRecordsIn / readRecordsUnder read records and skip temp files, directories and a missing directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'records-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'plumbhome', '.local', 'share', 'plumb', 'sessions')
  fs.mkdirSync(path.join(dir, 'subdir.json'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'a.json'), sessionFile({ id: 'a', client_name: 'dsh-mcp-client' }))
  fs.writeFileSync(path.join(dir, 'b.json'), sessionFile({ id: 'b', client_name: 'dsh-plumb-identity' }))
  fs.writeFileSync(path.join(dir, '.session-1.json.tmp'), sessionFile({ id: 'tmp', client_name: 'dsh-plumb-identity' }))
  fs.writeFileSync(path.join(dir, 'half.json'), '{"id":')
  assert.deepEqual(readRecordsIn(dir).map((r) => r.id).sort(), ['a', 'b'])
  assert.deepEqual(readRecordsUnder(path.join(root, 'plumbhome')).map((r) => r.id).sort(), ['a', 'b'])
  assert.deepEqual(readRecordsIn(path.join(root, 'nope')), [], 'a directory not created yet')
  assert.deepEqual(readRecordsUnder(path.join(root, 'nope')), [])
})

test('readRecordsIn: a directory it cannot read is an error, not "no records"', (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root reads everything')
    return
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'records-'))
  const dir = path.join(root, 'sessions')
  fs.mkdirSync(dir)
  t.after(() => {
    fs.chmodSync(dir, 0o700)
    fs.rmSync(root, { recursive: true, force: true })
  })
  fs.chmodSync(dir, 0o000)
  assert.throws(() => readRecordsIn(dir), /cannot read the session directory/)
})

test('inNamespace keeps exactly the namespace\'s records', () => {
  const records = [
    parseSessionRecord(sessionFile({ id: 'one', client_name: 'x', namespace: 'ns-aaaa1111' })),
    parseSessionRecord(sessionFile({ id: 'two', client_name: 'x', namespace: 'ns-bbbb2222' })),
    parseSessionRecord(sessionFile({ id: 'three', client_name: 'x' })),
    parseSessionRecord(sessionFile({ id: 'four', client_name: 'x', namespace: 'ns-aaaa1111' })),
  ]
  assert.deepEqual(inNamespace(records, 'ns-aaaa1111').map((r) => r.id), ['one', 'four'])
  assert.deepEqual(inNamespace(records, 'ns-cccc3333'), [])
})

test('inNamespace never selects the default namespace: an empty id throws', () => {
  const records = [parseSessionRecord(sessionFile({ id: 'default', client_name: 'x' }))]
  for (const bad of ['', undefined, null, 7]) {
    assert.throws(() => inNamespace(records, bad), /namespace id is required/, `id ${JSON.stringify(bad)}`)
  }
})

test('strayRecords: the e2e\'s own sessions outside the namespace, since the scenario began', () => {
  const since = Date.parse('2026-10-15T20:00:00Z')
  const make = (id, client, namespace, startedAt) => parseSessionRecord(sessionFile({
    id, client_name: client, namespace, started_at: startedAt,
  }))
  const records = [
    make('mine', 'dsh-plumb-identity', 'ns-aaaa1111', '2026-10-15T20:00:05Z'),
    make('leaked-default', 'dsh-plumb-identity', undefined, '2026-10-15T20:00:05Z'),
    make('leaked-shared', 'dsh-mcp-client', undefined, '2026-10-15T20:00:06Z'),
    make('leaked-sender', 'dsh-identity-e2e-sender', undefined, '2026-10-15T20:00:07Z'),
    make('other-namespace', 'dsh-plumb-identity', 'ns-bbbb2222', '2026-10-15T20:00:08Z'),
    make('older', 'dsh-plumb-identity', undefined, '2026-10-15T19:59:00Z'),
    make('someone-else', 'claude-code', undefined, '2026-10-15T20:00:09Z'),
    parseSessionRecord(sessionFile({ id: 'no-start', client_name: 'dsh-mcp-client', started_at: 'garbage' })),
  ]
  assert.deepEqual(strayRecords(records, 'ns-aaaa1111', since).map((r) => r.id).sort(), ['leaked-default', 'leaked-sender', 'leaked-shared', 'other-namespace'])
  assert.deepEqual(E2E_CLIENT_NAMES, ['dsh-plumb-identity', 'dsh-mcp-client', 'dsh-identity-e2e-sender'])
})

test('logLinesForSessions: a shared daemon\'s lines, narrowed to a scenario\'s sessions', () => {
  const log = [
    'time=1 level=INFO msg="daemon: ready"',
    'time=2 level=WARN msg="daemon: shared connection detected — multiple logical agents" session_id=1111-aaaa agent=dsh-x',
    'time=3 level=WARN msg="daemon: shared connection detected — multiple logical agents" session_id=2222-bbbb agent=dsh-y',
    'time=4 level=INFO msg="other" session_id="3333-cccc" k=v',
    'time=5 level=INFO msg="prefix only" session_id=1111-aaaa-extra',
    'time=6 level=INFO msg="mentions it" detail=session_id=1111-aaaa',
  ].join('\n')
  const mine = logLinesForSessions(log, ['1111-aaaa'])
  assert.match(mine, /time=2 /)
  assert.doesNotMatch(mine, /time=3 /, 'another session\'s warning')
  assert.doesNotMatch(mine, /time=1 /, 'a line with no session')
  assert.doesNotMatch(mine, /time=5 /, 'an id that merely starts with ours')
  assert.match(logLinesForSessions(log, ['3333-cccc']), /time=4 /, 'a quoted value')
  assert.equal(logLinesForSessions(log, []), '', 'no sessions, no lines')
  assert.equal(logLinesForSessions(log, ['', null]), '', 'empty ids select nothing')
})
