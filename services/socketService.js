const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const { getSetting } = require('../settings');

let io = null;

const USER_ROOM_PREFIX = 'user:';
const ADMINS_ROOM = 'admins';

const getTokenFromSocket = (socket) => {
  const authToken = socket.handshake?.auth?.token;
  const queryToken = socket.handshake?.query?.token;
  const header = socket.handshake?.headers?.authorization;

  if (authToken) return String(authToken).trim();
  if (queryToken) return String(queryToken).trim();
  if (header && String(header).startsWith('Bearer ')) {
    return String(header).slice('Bearer '.length).trim();
  }
  return '';
};

const authenticateSocket = async (socket, next) => {
  const token = getTokenFromSocket(socket);
  if (!token) {
    return next(new Error('Authorization token missing'));
  }

  try {
    const blacklisted = await query(
      'SELECT 1 FROM token_blacklist WHERE token = $1 AND expires_at > SYSUTCDATETIME()',
      [token]
    );
    if (blacklisted.rowCount > 0) {
      return next(new Error('Token has been revoked'));
    }

    const payload = jwt.verify(token, getSetting('JWT_SECRET'));
    socket.user = payload;
    socket.token = token;
    return next();
  } catch (_) {
    return next(new Error('Invalid or expired token'));
  }
};

const configureSocketServer = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  io.use(authenticateSocket);

  io.on('connection', (socket) => {
    const userId = Number(socket.user?.sub);
    const isAdmin = Boolean(socket.user?.isAdmin);

    if (Number.isInteger(userId) && userId > 0) {
      socket.join(`${USER_ROOM_PREFIX}${userId}`);
    }
    if (isAdmin) {
      socket.join(ADMINS_ROOM);
    }

    console.log(
      `[WS] connected socket=${socket.id} user=${userId || 'unknown'} admin=${isAdmin ? 'yes' : 'no'}`
    );

    socket.emit('socket:ready', {
      socketId: socket.id,
      userId,
      isAdmin,
      serverTime: new Date().toISOString(),
    });

    socket.on('app:ping', (payload, ack) => {
      const response = {
        ok: true,
        echo: payload ?? null,
        serverTime: new Date().toISOString(),
      };
      if (typeof ack === 'function') ack(response);
      socket.emit('app:pong', response);
    });

    socket.on('cricket:live:get', async (_, ack) => {
      try {
        const { getApiCricketLiveSnapshot, refreshLiveSnapshot } = require('./apiCricketRealtime');
        const snapshot = getApiCricketLiveSnapshot();
        const freshSnapshot = snapshot?.ts ? snapshot : await refreshLiveSnapshot({ forceOdds: true });
        if (typeof ack === 'function') ack({ ok: true, ...freshSnapshot });
        socket.emit('cricket:live:update', freshSnapshot);
      } catch (error) {
        const payload = { ok: false, error: error.message || 'Unable to load live cricket snapshot' };
        if (typeof ack === 'function') ack(payload);
        socket.emit('cricket:live:error', payload);
      }
    });

    socket.on('disconnect', (reason) => {
      console.log(`[WS] disconnected socket=${socket.id} user=${userId || 'unknown'} reason=${reason}`);
    });
  });

  console.log('[WS] Socket.IO server configured on /socket.io');
  return io;
};

const getSocketServer = () => io;

const emitToUser = (userId, eventName, payload) => {
  const recipientId = Number(userId);
  if (!io || !Number.isInteger(recipientId) || recipientId <= 0 || !eventName) return false;
  io.to(`${USER_ROOM_PREFIX}${recipientId}`).emit(eventName, payload);
  return true;
};

const emitToAdmins = (eventName, payload) => {
  if (!io || !eventName) return false;
  io.to(ADMINS_ROOM).emit(eventName, payload);
  return true;
};

const emitToAll = (eventName, payload) => {
  if (!io || !eventName) return false;
  io.emit(eventName, payload);
  return true;
};

module.exports = {
  configureSocketServer,
  getSocketServer,
  emitToUser,
  emitToAdmins,
  emitToAll,
};
