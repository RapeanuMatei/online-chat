const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 }); // 5 MB so pictures fit

app.use(express.static("public"));
// Invite links open the app; the client then asks the server whether the link is valid
app.get("/join/:token", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const MAX_MESSAGES = 200; // kept per group
const MAX_AVATAR = 150_000;
const MAX_PHOTO = 700_000;
const MAX_GROUPS_PER_USER = 20;

/* ---------- Data (in memory for now, so it resets when the server restarts) ---------- */
const users = new Map(); // userId -> { id, name, avatar, token }
const userByToken = new Map(); // secret token -> userId
const groups = new Map(); // groupId -> { id, name, adminId, members:Set, messages:[], invite }
const invites = new Map(); // invite token -> groupId
const socketUser = new Map(); // socket.id -> userId
const openSockets = new Map(); // userId -> number of open tabs (for online status)

const newToken = () => crypto.randomBytes(24).toString("base64url");
const room = (groupId) => `g:${groupId}`;
const userRoom = (userId) => `u:${userId}`;

/* ---------- Helpers ---------- */
function isImage(data, maxLength) {
  return typeof data === "string" && data.length <= maxLength &&
    /^data:image\/(jpeg|png|webp|gif);base64,/.test(data);
}
const cleanName = (value, max) => String(value || "").trim().slice(0, max);
function cleanProfile(raw) {
  return {
    name: cleanName(raw?.name, 20) || "Guest",
    avatar: isImage(raw?.avatar, MAX_AVATAR) ? raw.avatar : null,
  };
}
const publicUser = (id) => {
  const u = users.get(id);
  return { id, name: u.name, avatar: u.avatar };
};
const groupsOf = (userId) => [...groups.values()].filter((g) => g.members.has(userId));

function groupInfo(g) {
  return {
    id: g.id,
    name: g.name,
    adminId: g.adminId,
    members: [...g.members].map((id) => ({ ...publicUser(id), online: openSockets.has(id) })),
  };
}
function sendList(userId) {
  io.to(userRoom(userId)).emit("groups", groupsOf(userId).map((g) => ({
    id: g.id, name: g.name, count: g.members.size,
  })));
}
const sendGroup = (g) => io.to(room(g.id)).emit("group", groupInfo(g));
function refresh(g) {
  sendGroup(g);
  g.members.forEach(sendList);
}
function newInvite(g) {
  if (g.invite) invites.delete(g.invite); // the old link stops working
  g.invite = newToken();
  invites.set(g.invite, g.id);
}
function addMember(g, userId) {
  g.members.add(userId);
  io.in(userRoom(userId)).socketsJoin(room(g.id)); // all of this user's open tabs
}

/* ---------- Sockets ---------- */
io.on("connection", (socket) => {
  const me = () => users.get(socketUser.get(socket.id));
  // Returns the group only if the logged-in user is a member
  const memberGroup = (id) => {
    const g = groups.get(String(id));
    return g && me() && g.members.has(me().id) ? g : null;
  };
  const adminGroup = (id) => {
    const g = memberGroup(id);
    return g && g.adminId === me().id ? g : null;
  };

  socket.on("auth", (data, ack) => {
    if (socketUser.has(socket.id)) return;
    let user = users.get(userByToken.get(String(data?.token)));
    if (!user) {
      // New visitor (or the server restarted): register with the saved name and picture
      user = { id: crypto.randomUUID(), token: newToken(), ...cleanProfile(data?.profile) };
      users.set(user.id, user);
      userByToken.set(user.token, user.id);
    }
    socketUser.set(socket.id, user.id);
    openSockets.set(user.id, (openSockets.get(user.id) || 0) + 1);
    socket.join(userRoom(user.id));
    groupsOf(user.id).forEach((g) => { socket.join(room(g.id)); sendGroup(g); });
    sendList(user.id);
    ack?.({ token: user.token, user: publicUser(user.id) });
  });

  socket.on("profile", (raw) => {
    const user = me();
    if (!user) return;
    Object.assign(user, cleanProfile(raw));
    groupsOf(user.id).forEach(sendGroup);
  });

  socket.on("group:create", (name, ack) => {
    const user = me();
    if (!user) return;
    const clean = cleanName(name, 30);
    if (!clean) return ack?.({ error: "Give the group a name." });
    if (groupsOf(user.id).length >= MAX_GROUPS_PER_USER) return ack?.({ error: "You've reached the group limit." });
    const g = { id: crypto.randomUUID(), name: clean, adminId: user.id, members: new Set(), messages: [], invite: null };
    groups.set(g.id, g);
    newInvite(g);
    addMember(g, user.id);
    sendList(user.id);
    ack?.({ id: g.id });
  });

  socket.on("group:open", (id, ack) => {
    const g = memberGroup(id);
    if (!g) return ack?.({ error: "You're not a member of this group." });
    ack?.({
      group: groupInfo(g),
      invite: g.adminId === me().id ? g.invite : undefined, // only the admin sees the link
      messages: g.messages,
    });
  });

  socket.on("group:rename", (id, name, ack) => {
    const g = adminGroup(id);
    const clean = cleanName(name, 30);
    if (!g || !clean) return ack?.({ error: "Only the admin can rename the group." });
    g.name = clean;
    refresh(g);
    ack?.({ ok: true });
  });

  socket.on("invite:new", (id, ack) => {
    const g = adminGroup(id);
    if (!g) return ack?.({ error: "Only the admin can do that." });
    newInvite(g);
    ack?.({ invite: g.invite });
  });

  socket.on("invite:revoke", (id, ack) => {
    const g = adminGroup(id);
    if (!g) return ack?.({ error: "Only the admin can do that." });
    if (g.invite) invites.delete(g.invite);
    g.invite = null;
    ack?.({ invite: null });
  });

  // Shows only the group name and size, never messages or members
  socket.on("invite:preview", (token, ack) => {
    const g = groups.get(invites.get(String(token)));
    if (!g || !me()) return ack?.({ error: "This invite link isn't valid any more." });
    const member = g.members.has(me().id);
    ack?.({ name: g.name, count: g.members.size, member, groupId: member ? g.id : undefined });
  });

  // Joining happens only when the user explicitly asks
  socket.on("invite:join", (token, ack) => {
    const g = groups.get(invites.get(String(token)));
    const user = me();
    if (!g || !user) return ack?.({ error: "This invite link isn't valid any more." });
    if (!g.members.has(user.id)) {
      if (groupsOf(user.id).length >= MAX_GROUPS_PER_USER) return ack?.({ error: "You've reached the group limit." });
      addMember(g, user.id);
      refresh(g);
    }
    ack?.({ id: g.id });
  });

  socket.on("group:leave", (id, ack) => {
    const g = memberGroup(id);
    const user = me();
    if (!g) return;
    g.members.delete(user.id);
    io.in(userRoom(user.id)).socketsLeave(room(g.id));
    if (g.adminId === user.id) {
      g.adminId = [...g.members][0] || null; // longest-standing member becomes admin
      if (!g.adminId && g.invite) { invites.delete(g.invite); g.invite = null; }
    }
    refresh(g);
    sendList(user.id);
    ack?.({ ok: true });
  });

  socket.on("message", (data) => {
    const g = memberGroup(data?.groupId);
    if (!g) return;
    const text = cleanName(data?.text, 1000);
    const image = isImage(data?.image, MAX_PHOTO) ? data.image : null;
    if (!text && !image) return;
    const msg = { id: crypto.randomUUID(), userId: me().id, text, image, time: Date.now() };
    g.messages.push(msg);
    if (g.messages.length > MAX_MESSAGES) g.messages.shift();
    io.to(room(g.id)).emit("message", { groupId: g.id, ...msg });
  });

  socket.on("typing", (data) => {
    const g = memberGroup(data?.groupId);
    if (g) socket.to(room(g.id)).emit("typing", { groupId: g.id, userId: me().id, isTyping: !!data.isTyping });
  });

  socket.on("disconnect", () => {
    const user = me();
    socketUser.delete(socket.id);
    if (!user) return;
    const left = (openSockets.get(user.id) || 1) - 1;
    left > 0 ? openSockets.set(user.id, left) : openSockets.delete(user.id);
    groupsOf(user.id).forEach((g) => {
      io.to(room(g.id)).emit("typing", { groupId: g.id, userId: user.id, isTyping: false });
      sendGroup(g);
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`FriendChat running at http://localhost:${PORT}`));