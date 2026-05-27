/**
 * WhatsAppInstance — wraps a single whatsapp-web.js Client.
 * Manages its lifecycle: connect → QR → authenticated → ready → events.
 */
import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import { createWriteStream, mkdirSync } from 'fs';
import { join } from 'path';
import { config } from '../config/index.js';

const QR_TTL_SECONDS = 60;

export class WhatsAppInstance {
  /** @type {string} */
  id;
  /** @type {import('ioredis').Redis} */
  redis;
  /** @type {Function} onEvent - called with (instanceId, eventType, data) */
  onEvent;
  /** @type {Client|null} */
  client = null;
  /** @type {string} */
  status = 'disconnected';

  constructor({ id, redis, onEvent }) {
    this.id = id;
    this.redis = redis;
    this.onEvent = onEvent;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async connect() {
    if (this.client) {
      console.log(`[${this.id}] Already initialized, skipping connect`);
      return;
    }

    await this._setStatus('initializing');

    const sessionPath = join(config.sessions.path, this.id);
    mkdirSync(sessionPath, { recursive: true });

    const puppeteerOpts = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
      ],
    };

    if (config.puppeteer.executablePath) {
      puppeteerOpts.executablePath = config.puppeteer.executablePath;
    }

    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: this.id, dataPath: config.sessions.path }),
      puppeteer: puppeteerOpts,
    });

    this._bindEvents();
    await this.client.initialize();
  }

  async logout() {
    if (!this.client) return;
    try {
      await this.client.logout();
    } catch {}
    await this.destroy();
  }

  async destroy() {
    if (!this.client) return;
    try {
      await this.client.destroy();
    } catch {}
    this.client = null;
    await this._setStatus('disconnected');
    await this.redis.del(`instance:${this.id}:qr`);
    await this.redis.del(`instance:${this.id}:phone`);
  }

  // ── RPC handlers — called by InstanceManager ──────────────────────────────

  async handleRpc(method, params) {
    if (!this.client) throw new Error('Instance not connected');

    switch (method) {
      case 'getChats': return this._getChats(params);
      case 'getChat': return this._getChat(params);
      case 'getChatMessages': return this._getChatMessages(params);
      case 'markChatRead': return this._markChatRead(params);
      case 'getContacts': return this._getContacts(params);
      case 'getContact': return this._getContact(params);
      case 'checkPhones': return this._checkPhones(params);
      case 'getGroups': return this._getGroups(params);
      case 'getGroup': return this._getGroup(params);
      case 'createGroup': return this._createGroup(params);
      case 'addGroupParticipants': return this._addGroupParticipants(params);
      case 'removeGroupParticipant': return this._removeGroupParticipant(params);
      case 'leaveGroup': return this._leaveGroup(params);
      default: throw new Error(`Unknown RPC method: ${method}`);
    }
  }

  async sendMessage(params) {
    const { to, type, text, caption, mediaUrl, mediaBase64, mimeType,
            filename, latitude, longitude, locationName, replyToMessageId } = params;

    const chatId = to.includes('@') ? to : `${to}@c.us`;
    const options = {};

    if (replyToMessageId) {
      // Fetch the message to reply to
      try {
        const chat = await this.client.getChatById(chatId);
        const messages = await chat.fetchMessages({ limit: 50 });
        const quotedMsg = messages.find(m => m.id._serialized === replyToMessageId);
        if (quotedMsg) options.quotedMessageId = quotedMsg.id._serialized;
      } catch {}
    }

    let message;

    switch (type) {
      case 'text':
        message = await this.client.sendMessage(chatId, text, options);
        break;

      case 'image':
      case 'video':
      case 'audio':
      case 'document': {
        let media;
        if (mediaUrl) {
          media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
        } else {
          media = new MessageMedia(mimeType, mediaBase64, filename);
        }
        if (caption) options.caption = caption;
        if (filename && type === 'document') options.sendMediaAsDocument = true;
        message = await this.client.sendMessage(chatId, media, options);
        break;
      }

      case 'location': {
        const { Location } = await import('whatsapp-web.js');
        const loc = new Location(latitude, longitude, locationName);
        message = await this.client.sendMessage(chatId, loc, options);
        break;
      }

      default:
        throw new Error(`Unsupported message type: ${type}`);
    }

    return {
      messageId: message.id._serialized,
      timestamp: message.timestamp,
    };
  }

  // ── Event binding ─────────────────────────────────────────────────────────

  _bindEvents() {
    const c = this.client;

    c.on('qr', async (qr) => {
      await this._setStatus('qr_pending');
      // Store QR as base64 string (raw QR data, client can render)
      await this.redis.setex(`instance:${this.id}:qr`, QR_TTL_SECONDS, qr);
      await this.onEvent(this.id, 'qr', { qr });
    });

    c.on('authenticated', async () => {
      await this._setStatus('authenticated');
      await this.redis.del(`instance:${this.id}:qr`);
      await this.onEvent(this.id, 'authenticated', {});
    });

    c.on('auth_failure', async (msg) => {
      await this._setStatus('error');
      await this.onEvent(this.id, 'auth_failure', { message: msg });
    });

    c.on('ready', async () => {
      const info = c.info;
      const phone = info?.wid?.user;
      if (phone) {
        await this.redis.set(`instance:${this.id}:phone`, phone);
      }
      await this._setStatus('connected');
      await this.onEvent(this.id, 'authenticated', { phone });
    });

    c.on('disconnected', async (reason) => {
      await this._setStatus('disconnected');
      await this.redis.del(`instance:${this.id}:qr`);
      await this.onEvent(this.id, 'disconnected', { reason });
    });

    c.on('message', async (msg) => {
      await this.onEvent(this.id, 'message', this._serializeMessage(msg));
    });

    c.on('message_create', async (msg) => {
      if (msg.fromMe) {
        await this.onEvent(this.id, 'message_create', this._serializeMessage(msg));
      }
    });

    c.on('message_ack', async (msg, ack) => {
      await this.onEvent(this.id, 'message_ack', {
        messageId: msg.id._serialized,
        ack,
        to: msg.to,
      });
    });

    c.on('message_revoke_everyone', async (msg, revokedMsg) => {
      await this.onEvent(this.id, 'message_revoked', {
        messageId: revokedMsg?.id?._serialized,
        revokedBy: msg.author || msg.from,
      });
    });

    c.on('call', async (call) => {
      await this.onEvent(this.id, 'call', {
        callId: call.id,
        from: call.from,
        isGroup: call.isGroup,
        isVideo: call.isVideo,
        timestamp: call.timestamp,
      });
    });

    c.on('group_join', async (notification) => {
      await this.onEvent(this.id, 'group_join', {
        groupId: notification.chatId,
        participants: notification.recipientIds,
        actor: notification.author,
      });
    });

    c.on('group_leave', async (notification) => {
      await this.onEvent(this.id, 'group_leave', {
        groupId: notification.chatId,
        participants: notification.recipientIds,
        actor: notification.author,
      });
    });

    c.on('group_admin_changed', async (notification) => {
      await this.onEvent(this.id, 'group_admin_changed', {
        groupId: notification.chatId,
        participant: notification.recipientIds[0],
        type: notification.type, // promote / demote
      });
    });

    c.on('contact_changed', async (message, oldId, newId, isContact) => {
      await this.onEvent(this.id, 'contact_changed', { oldId, newId, isContact });
    });
  }

  // ── RPC implementations ───────────────────────────────────────────────────

  async _getChats({ limit = 50, archived = false }) {
    const chats = await this.client.getChats();
    return chats
      .filter(c => archived ? c.archived : !c.archived)
      .slice(0, limit)
      .map(c => ({
        id: c.id._serialized,
        name: c.name,
        isGroup: c.isGroup,
        isReadOnly: c.isReadOnly,
        unreadCount: c.unreadCount,
        timestamp: c.timestamp,
        archived: c.archived,
        pinned: c.pinned,
        lastMessage: c.lastMessage ? this._serializeMessage(c.lastMessage) : null,
      }));
  }

  async _getChat({ chatId }) {
    try {
      const chat = await this.client.getChatById(chatId);
      return {
        id: chat.id._serialized,
        name: chat.name,
        isGroup: chat.isGroup,
        unreadCount: chat.unreadCount,
        timestamp: chat.timestamp,
        archived: chat.archived,
        pinned: chat.pinned,
      };
    } catch {
      return null;
    }
  }

  async _getChatMessages({ chatId, limit = 50, fromMessageId }) {
    const chat = await this.client.getChatById(chatId);
    const opts = { limit };
    if (fromMessageId) opts.fromMe = false; // simplify for now
    const messages = await chat.fetchMessages(opts);
    return messages.map(m => this._serializeMessage(m));
  }

  async _markChatRead({ chatId }) {
    const chat = await this.client.getChatById(chatId);
    await chat.sendSeen();
  }

  async _getContacts({ limit = 100, search }) {
    let contacts = await this.client.getContacts();
    if (search) {
      const q = search.toLowerCase();
      contacts = contacts.filter(c =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.number || '').includes(q),
      );
    }
    return contacts.slice(0, limit).map(c => ({
      id: c.id._serialized,
      name: c.name || c.pushname,
      number: c.number,
      isMyContact: c.isMyContact,
      isBlocked: c.isBlocked,
      isGroup: c.isGroup,
    }));
  }

  async _getContact({ contactId }) {
    try {
      const contact = await this.client.getContactById(contactId);
      const profilePic = await contact.getProfilePicUrl().catch(() => null);
      return {
        id: contact.id._serialized,
        name: contact.name || contact.pushname,
        number: contact.number,
        isMyContact: contact.isMyContact,
        isBlocked: contact.isBlocked,
        about: await contact.getAbout().catch(() => null),
        profilePicUrl: profilePic,
      };
    } catch {
      return null;
    }
  }

  async _checkPhones({ phones }) {
    return Promise.all(phones.map(async (phone) => {
      try {
        const result = await this.client.isRegisteredUser(`${phone}@c.us`);
        return { phone, isOnWhatsApp: result, jid: result ? `${phone}@c.us` : null };
      } catch {
        return { phone, isOnWhatsApp: false, jid: null };
      }
    }));
  }

  async _getGroups() {
    const chats = await this.client.getChats();
    const groups = chats.filter(c => c.isGroup);
    return Promise.all(groups.map(async (g) => ({
      id: g.id._serialized,
      name: g.name,
      description: g.description,
      participantCount: g.participants?.length ?? 0,
      isReadOnly: g.isReadOnly,
      timestamp: g.timestamp,
    })));
  }

  async _getGroup({ groupId }) {
    try {
      const chat = await this.client.getChatById(groupId);
      if (!chat.isGroup) return null;
      const inviteCode = await chat.getInviteCode().catch(() => null);
      return {
        id: chat.id._serialized,
        name: chat.name,
        description: chat.description,
        participants: chat.participants?.map(p => ({
          id: p.id._serialized,
          isAdmin: p.isAdmin,
          isSuperAdmin: p.isSuperAdmin,
        })),
        inviteLink: inviteCode ? `https://chat.whatsapp.com/${inviteCode}` : null,
        isReadOnly: chat.isReadOnly,
      };
    } catch {
      return null;
    }
  }

  async _createGroup({ name, participants }) {
    const result = await this.client.createGroup(name, participants.map(p => `${p}@c.us`));
    const inviteCode = await result.getInviteCode().catch(() => null);
    return {
      groupId: result.gid._serialized,
      name,
      inviteCode,
    };
  }

  async _addGroupParticipants({ groupId, participants }) {
    const chat = await this.client.getChatById(groupId);
    const result = await chat.addParticipants(participants.map(p => `${p}@c.us`));
    return result;
  }

  async _removeGroupParticipant({ groupId, phone }) {
    const chat = await this.client.getChatById(groupId);
    await chat.removeParticipants([`${phone}@c.us`]);
    return { message: `Removed ${phone} from group` };
  }

  async _leaveGroup({ groupId }) {
    const chat = await this.client.getChatById(groupId);
    await chat.leave();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  async _setStatus(status) {
    this.status = status;
    await this.redis.set(`instance:${this.id}:status`, status);
  }

  _serializeMessage(msg) {
    return {
      id: msg.id?._serialized,
      body: msg.body,
      type: msg.type,
      from: msg.from,
      to: msg.to,
      author: msg.author,
      timestamp: msg.timestamp,
      fromMe: msg.fromMe,
      hasMedia: msg.hasMedia,
      ack: msg.ack,
      isForwarded: msg.isForwarded,
    };
  }
}
