'use strict';
/* Shared Rooms service — M4a slice (ROOM-001…010 except burn-rate views).
 * Every function takes ({ doc, tables }) so tests inject the same seam as production.
 * AuthZ lives here, not in routes: valid session alone grants nothing (SEC-002).
 */
const {
  GetCommand, PutCommand, UpdateCommand, QueryCommand, TransactWriteCommand,
} = require('@aws-sdk/lib-dynamodb');
const { badRequest, forbidden, notFound, conflict, goneFrozen } = require('./errors');
const { entityId, inviteToken, lockOwner, nowIso, nowEpoch } = require('./ids');
const { LEASES, withLock } = require('./locks');
const { newEvent, putEventItem } = require('./outbox');

const ROOM_KEY = (roomId) => `LOCK#ROOM#${roomId}`;
const INVITE_DEFAULT_TTL_SEC = 7 * 24 * 3600;
const ROOM_CAPACITY_DEFAULT = 20;

async function getRoomRow(doc, tables, roomId) {
  const r = await doc.send(new GetCommand({ TableName: tables.rooms, Key: { roomId } }));
  if (!r.Item) throw notFound('room not found');
  return r.Item;
}

async function getMembership(doc, tables, roomId, userId) {
  const r = await doc.send(new GetCommand({
    TableName: tables.memberships, Key: { roomId, workosUserId: userId },
  }));
  return r.Item || null;
}

/* Throws 404 for non-members (existence hiding), 403 for wrong role. */
async function requireRole(doc, tables, roomId, userId, roles) {
  await getRoomRow(doc, tables, roomId); // 404 when room missing
  const m = await getMembership(doc, tables, roomId, userId);
  if (!m || m.status !== 'ACTIVE') throw notFound('room not found');
  if (!roles.includes(m.role)) throw forbidden('insufficient room role');
  return m;
}

async function assertWritable(room) {
  if (room.status === 'FROZEN') throw goneFrozen();
}

function outboxRoomEvent(tables, type, roomId, payload) {
  return putEventItem(tables.outbox, newEvent(type, 'room', roomId, payload));
}

async function createRoom({ doc, tables }, { ownerId, name, settings = {} }) {
  if (!ownerId || typeof ownerId !== 'string') throw badRequest('bad-user', 'ownerId required');
  if (!name || name.trim().length === 0) throw badRequest('bad-name', 'room name required');
  const roomId = entityId('rm_');
  const now = nowIso();
  const room = {
    roomId, name: name.trim(), ownerId, status: 'ACTIVE', subscriptionId: null,
    settings: { capacity: ROOM_CAPACITY_DEFAULT, ...settings },
    v: 1, createdAt: now, updatedAt: now,
  };
  const membership = {
    roomId, workosUserId: ownerId, role: 'OWNER', status: 'ACTIVE', joinedAt: now,
  };
  await doc.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: tables.rooms, Item: room } },
      { Put: { TableName: tables.memberships, Item: membership } },
      outboxRoomEvent(tables, 'RoomMemberJoined', roomId, { userId: ownerId, role: 'OWNER' }),
    ],
  }));
  return { room, membership };
}

async function getRoom({ doc, tables }, { requesterId, roomId }) {
  const m = await requireRole(doc, tables, roomId, requesterId, ['OWNER', 'MEMBER']);
  const room = await getRoomRow(doc, tables, roomId);
  return { room, role: m.role };
}

async function listMembers({ doc, tables }, { requesterId, roomId }) {
  await requireRole(doc, tables, roomId, requesterId, ['OWNER', 'MEMBER']);
  const r = await doc.send(new QueryCommand({
    TableName: tables.memberships,
    KeyConditionExpression: 'roomId = :r',
    ExpressionAttributeValues: { ':r': roomId },
  }));
  return (r.Items || []).filter((m) => m.status === 'ACTIVE');
}

async function generateInvite({ doc, tables }, { actorId, roomId, maxUses = 1, ttlSec = INVITE_DEFAULT_TTL_SEC }) {
  await requireRole(doc, tables, roomId, actorId, ['OWNER']);
  const room = await getRoomRow(doc, tables, roomId);
  await assertWritable(room);
  if (!Number.isInteger(maxUses) || maxUses < 1) throw badRequest('bad-uses', 'maxUses >= 1');
  const invite = {
    token: inviteToken(), roomId, createdBy: actorId, maxUses, useCount: 0,
    expiresAt: nowEpoch() + ttlSec, revoked: false, createdAt: nowIso(),
  };
  await doc.send(new PutCommand({ TableName: tables.invitations, Item: invite }));
  return invite; // token shown once to the owner; stored row carries no PII (SEC-004)
}

async function revokeInvite({ doc, tables }, { actorId, roomId, token }) {
  await requireRole(doc, tables, roomId, actorId, ['OWNER']);
  await doc.send(new UpdateCommand({
    TableName: tables.invitations,
    Key: { token },
    UpdateExpression: 'SET revoked = :t',
    ConditionExpression: 'roomId = :r',
    ExpressionAttributeValues: { ':t': true, ':r': roomId },
  })).catch((err) => {
    if (err.name === 'ConditionalCheckFailedException') throw notFound('invitation not found');
    throw err;
  });
  return { revoked: true };
}

async function joinRoom({ doc, tables }, { userId, token }) {
  if (!token) throw badRequest('bad-token', 'invitation token required');
  const inv = await doc.send(new GetCommand({ TableName: tables.invitations, Key: { token } }));
  const invite = inv.Item;
  if (!invite || invite.revoked || invite.expiresAt <= nowEpoch() || invite.useCount >= invite.maxUses) {
    throw notFound('invitation invalid or expired'); // one error shape for all token failures
  }
  const roomId = invite.roomId;
  return withLock(doc, tables.locks, ROOM_KEY(roomId), lockOwner(), LEASES.join, async () => {
    const room = await getRoomRow(doc, tables, roomId);
    await assertWritable(room);
    const existing = await getMembership(doc, tables, roomId, userId);
    if (existing && existing.status === 'ACTIVE') return { roomId, alreadyMember: true }; // idempotent
    const members = await listMembers({ doc, tables }, { requesterId: room.ownerId, roomId });
    if (members.length >= (room.settings.capacity || ROOM_CAPACITY_DEFAULT)) {
      throw conflict('room-full', 'room at capacity');
    }
    // Atomic consume: exactly one concurrent joiner wins per use (ROOM-003).
    await doc.send(new UpdateCommand({
      TableName: tables.invitations,
      Key: { token },
      UpdateExpression: 'ADD useCount :one',
      ConditionExpression: 'revoked = :false AND expiresAt > :now AND useCount < maxUses',
      ExpressionAttributeValues: { ':one': 1, ':false': false, ':now': nowEpoch() },
    })).catch((err) => {
      if (err.name === 'ConditionalCheckFailedException') throw notFound('invitation invalid or expired');
      throw err;
    });
    try {
      await doc.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tables.memberships,
              Item: { roomId, workosUserId: userId, role: 'MEMBER', status: 'ACTIVE', joinedAt: nowIso() },
              ConditionExpression: 'attribute_not_exists(roomId)',
            },
          },
          outboxRoomEvent(tables, 'RoomMemberJoined', roomId, { userId, role: 'MEMBER' }),
        ],
      }));
    } catch (err) {
      if (err.name === 'TransactionCanceledException') {
        // Double-submit: exactly one membership exists (ROOM-003 idempotency).
        const m = await getMembership(doc, tables, roomId, userId);
        if (m && m.status === 'ACTIVE') return { roomId, alreadyMember: true };
      }
      throw err;
    }
    return { roomId, alreadyMember: false };
  });
}

/* Pure guard for transfer validation — unit-testable without a database. */
function validateTransfer({ room, requester, successor }) {
  if (!room) return 'no-room';
  if (room.status === 'FROZEN') return 'frozen';
  if (!requester || requester.role !== 'OWNER' || requester.status !== 'ACTIVE') return 'not-owner';
  if (!successor || successor.status !== 'ACTIVE' || successor.role === 'OWNER') return 'bad-successor';
  if (successor.workosUserId === requester.workosUserId) return 'self';
  return null;
}

async function transferOwnership({ doc, tables }, { actorId, roomId, successorId }) {
  if (!successorId) throw badRequest('bad-successor', 'successorId required');
  return withLock(doc, tables.locks, ROOM_KEY(roomId), lockOwner(), LEASES.transfer, async () => {
    const room = await getRoomRow(doc, tables, roomId);
    const requester = await getMembership(doc, tables, roomId, actorId);
    const successor = await getMembership(doc, tables, roomId, successorId);
    const problem = validateTransfer({ room, requester, successor });
    if (problem === 'no-room') throw notFound('room not found');
    if (problem === 'frozen') throw goneFrozen();
    if (problem) throw badRequest('transfer-rejected', `ownership transfer rejected: ${problem}`);
    const now = nowIso();
    await doc.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tables.rooms, Key: { roomId },
            UpdateExpression: 'SET ownerId = :s, updatedAt = :now ADD v :one',
            ConditionExpression: 'ownerId = :actor AND #st = :active',
            ExpressionAttributeNames: { '#st': 'status' },
            ExpressionAttributeValues: { ':s': successorId, ':actor': actorId, ':active': 'ACTIVE', ':now': now, ':one': 1 },
          },
        },
        {
          Update: {
            TableName: tables.memberships, Key: { roomId, workosUserId: actorId },
            UpdateExpression: 'SET #r = :member',
            ConditionExpression: '#r = :owner',
            ExpressionAttributeNames: { '#r': 'role' },
            ExpressionAttributeValues: { ':member': 'MEMBER', ':owner': 'OWNER' },
          },
        },
        {
          Update: {
            TableName: tables.memberships, Key: { roomId, workosUserId: successorId },
            UpdateExpression: 'SET #r = :owner',
            ConditionExpression: '#r = :member',
            ExpressionAttributeNames: { '#r': 'role' },
            ExpressionAttributeValues: { ':member': 'MEMBER', ':owner': 'OWNER' },
          },
        },
        outboxRoomEvent(tables, 'RoomMemberUpdated', roomId, { previousOwner: actorId, owner: successorId }),
      ],
    }));
    return { roomId, owner: successorId };
  });
}

async function netBalanceForUser(doc, tables, roomId, userId) {
  // M4a read path over the M4b-owned table (empty until #7 writes rows): zero is the safe default.
  const r = await doc.send(new QueryCommand({
    TableName: tables.balances,
    KeyConditionExpression: 'roomId = :r',
    ExpressionAttributeValues: { ':r': roomId },
    ProjectionExpression: 'pairKey, balanceMinor',
  }));
  let net = 0;
  for (const row of r.Items || []) {
    const [first, second] = String(row.pairKey).split('#');
    const v = Number(row.balanceMinor) || 0;
    if (first === userId) net += v;
    else if (second === userId) net -= v;
  }
  return net;
}

async function removeMember({ doc, tables }, { actorId, roomId, targetId }) {
  await requireRole(doc, tables, roomId, actorId, ['OWNER']);
  if (targetId === actorId) throw badRequest('bad-target', 'owner cannot remove self; transfer first');
  return withLock(doc, tables.locks, ROOM_KEY(roomId), lockOwner(), LEASES.transfer, async () => {
    const room = await getRoomRow(doc, tables, roomId);
    await assertWritable(room);
    const target = await getMembership(doc, tables, roomId, targetId);
    if (!target || target.status !== 'ACTIVE') throw notFound('member not found');
    if (target.role === 'OWNER') throw badRequest('bad-target', 'cannot remove the owner');
    if (await netBalanceForUser(doc, tables, roomId, targetId) !== 0) {
      throw conflict('unsettled-balance', 'member has unsettled balance');
    }
    await doc.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tables.memberships, Key: { roomId, workosUserId: targetId },
            UpdateExpression: 'SET #s = :removed',
            ConditionExpression: '#s = :active',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':removed': 'REMOVED', ':active': 'ACTIVE' },
          },
        },
        outboxRoomEvent(tables, 'RoomMemberRemoved', roomId, { userId: targetId }),
      ],
    }));
    return { roomId, removed: targetId };
  });
}

async function freezeRoom({ doc, tables }, { roomId, reason }) {
  const room = await getRoomRow(doc, tables, roomId);
  if (room.status === 'FROZEN') return { roomId, alreadyFrozen: true };
  await doc.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: tables.rooms, Key: { roomId },
          UpdateExpression: 'SET #s = :frozen, updatedAt = :now ADD v :one',
          ConditionExpression: '#s = :active',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':frozen': 'FROZEN', ':active': 'ACTIVE', ':now': nowIso(), ':one': 1 },
        },
      },
      outboxRoomEvent(tables, 'RoomFrozen', roomId, { reason: reason || 'owner-departed' }),
    ],
  }));
  return { roomId, frozen: true };
}

async function claimFrozenRoom({ doc, tables }, { userId, roomId }) {
  // Any ACTIVE member may claim ownership of a FROZEN room (DYNAMODB-DESIGN.md §4).
  return withLock(doc, tables.locks, ROOM_KEY(roomId), lockOwner(), LEASES.transfer, async () => {
    const room = await getRoomRow(doc, tables, roomId);
    if (room.status !== 'FROZEN') throw conflict('not-frozen', 'room is not frozen');
    const claimant = await getMembership(doc, tables, roomId, userId);
    if (!claimant || claimant.status !== 'ACTIVE') throw notFound('room not found');
    const now = nowIso();
    await doc.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tables.rooms, Key: { roomId },
            UpdateExpression: 'SET ownerId = :u, #s = :active, updatedAt = :now ADD v :one',
            ConditionExpression: '#s = :frozen',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':u': userId, ':frozen': 'FROZEN', ':active': 'ACTIVE', ':now': now, ':one': 1 },
          },
        },
        {
          Update: {
            TableName: tables.memberships, Key: { roomId, workosUserId: userId },
            UpdateExpression: 'SET #r = :owner',
            ExpressionAttributeNames: { '#r': 'role' },
            ExpressionAttributeValues: { ':owner': 'OWNER' },
          },
        },
        outboxRoomEvent(tables, 'RoomUnfrozen', roomId, { owner: userId }),
      ],
    }));
    return { roomId, owner: userId };
  });
}

async function listRooms({ doc, tables }, { userId }) {
  // M4a gap-fill for the UI: rooms the user actively belongs to, with their role attached.
  const q = await doc.send(new QueryCommand({
    TableName: tables.memberships, IndexName: 'gsi1-user',
    KeyConditionExpression: 'workosUserId = :u',
    ExpressionAttributeValues: { ':u': userId },
  }));
  const out = [];
  for (const m of q.Items || []) {
    if (m.status !== 'ACTIVE') continue;
    // eslint-disable-next-line no-await-in-loop
    const room = await doc.send(new GetCommand({ TableName: tables.rooms, Key: { roomId: m.roomId } }));
    if (room.Item) out.push({ ...room.Item, myRole: m.role });
  }
  return out;
}

module.exports = {
  requireRole, createRoom, getRoom, listRooms, listMembers, generateInvite, revokeInvite, joinRoom,
  validateTransfer, transferOwnership, removeMember, freezeRoom, claimFrozenRoom, netBalanceForUser,
};
