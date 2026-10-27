const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const MAX_HISTORY = 100;
const COLORS = ["#ff6b8b", "#ffb347", "#5ee0a0", "#5cc8ff", "#9b8cff", "#ff8fd8", "#ffd95c"];
const history = []; // last messages, kept in memory
const users = new Map(); // socket.id -> { id, name, color }

function addNotice(text) {
  const msg = { type: "notice", text, time: Date.now() };
  history.push(msg);
  io.emit("message", msg);
}

io.on("connection", (socket) => {
  socket.on("join", (rawName) => {
    const name = String(rawName || "").trim().slice(0, 20) || "Guest";
    const color = COLORS[users.size % COLORS.length];
    const user = { id: socket.id, name, color };
    users.set(socket.id, user);

    socket.emit("welcome", { me: user, history });
    io.emit("users", [...users.values()]);
    addNotice(`${name} joined the chat`);
  });

  socket.on("message", (rawText) => {
    const user = users.get(socket.id);
    const text = String(rawText || "").trim().slice(0, 1000);
    if (!user || !text) return;

    const msg = { type: "chat", user, text, time: Date.now() };
    history.push(msg);
    if (history.length > MAX_HISTORY) history.shift();
    io.emit("message", msg);
  });

  socket.on("typing", (isTyping) => {
    const user = users.get(socket.id);
    if (user) socket.broadcast.emit("typing", { name: user.name, isTyping });
  });

  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (!user) return;
    users.delete(socket.id);
    io.emit("users", [...users.values()]);
    io.emit("typing", { name: user.name, isTyping: false });
    addNotice(`${user.name} left`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`FriendChat running at http://localhost:${PORT}`));
