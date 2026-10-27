const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
// Allow bigger messages so pictures can be sent (5 MB)
const io = new Server(server, { maxHttpBufferSize: 5e6 });

app.use(express.static("public"));

const MAX_HISTORY = 100;
const MAX_AVATAR = 150_000; // characters of base64 data
const MAX_PHOTO = 700_000;

const history = []; // last messages: { userId, text, image, time }
const profiles = new Map(); // userId -> { id, name, avatar }
const sockets = new Map(); // socket.id -> userId

function isImage(data, maxLength) {
  return (
    typeof data === "string" &&
    data.length <= maxLength &&
    /^data:image\/(jpeg|png|webp|gif);base64,/.test(data)
  );
}

function cleanProfile(raw) {
  const id = String(raw?.id || "").slice(0, 60);
  if (!id) return null;
  const name = String(raw.name || "").trim().slice(0, 20) || "Guest";
  const avatar = isImage(raw.avatar, MAX_AVATAR) ? raw.avatar : null;
  return { id, name, avatar };
}

function sendPeople() {
  io.emit("people", {
    profiles: [...profiles.values()],
    online: [...new Set(sockets.values())],
  });
}

io.on("connection", (socket) => {
  // Someone opens the app (or reconnects) with their saved profile
  socket.on("join", (raw) => {
    const profile = cleanProfile(raw);
    if (!profile) return;
    profiles.set(profile.id, profile);
    sockets.set(socket.id, profile.id);
    socket.emit("welcome", history);
    sendPeople();
  });

  // Someone changes their name or picture
  socket.on("profile", (raw) => {
    const userId = sockets.get(socket.id);
    const profile = cleanProfile(raw);
    if (!userId || !profile || profile.id !== userId) return;
    profiles.set(userId, profile);
    sendPeople();
  });

  socket.on("message", (data) => {
    const userId = sockets.get(socket.id);
    if (!userId) return;
    const text = String(data?.text || "").trim().slice(0, 1000);
    const image = isImage(data?.image, MAX_PHOTO) ? data.image : null;
    if (!text && !image) return;

    const msg = { userId, text, image, time: Date.now() };
    history.push(msg);
    if (history.length > MAX_HISTORY) history.shift();
    io.emit("message", msg);
  });

  socket.on("typing", (isTyping) => {
    const userId = sockets.get(socket.id);
    if (userId) socket.broadcast.emit("typing", { userId, isTyping });
  });

  socket.on("disconnect", () => {
    const userId = sockets.get(socket.id);
    sockets.delete(socket.id);
    if (userId) io.emit("typing", { userId, isTyping: false });
    sendPeople();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`FriendChat running at http://localhost:${PORT}`));
