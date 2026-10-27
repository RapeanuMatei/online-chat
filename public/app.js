const socket = io();

const $ = (id) => document.getElementById(id);
const joinScreen = $("join");
const messagesEl = $("messages");
const typingEl = $("typing");
const msgInput = $("msgInput");

let me = null;
const typingUsers = new Set();
let typingTimeout = null;

/* ---------- Join ---------- */
$("joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  socket.emit("join", $("nameInput").value);
});

socket.on("welcome", ({ me: user, history }) => {
  me = user;
  joinScreen.classList.add("hidden");
  history.forEach(renderMessage);
  msgInput.focus();
});

/* ---------- Sending ---------- */
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text) return;
  socket.emit("message", text);
  socket.emit("typing", false);
  msgInput.value = "";
});

msgInput.addEventListener("input", () => {
  socket.emit("typing", true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit("typing", false), 1500);
});

/* ---------- Receiving ---------- */
socket.on("message", renderMessage);

socket.on("users", (users) => {
  $("onlineCount").textContent = `${users.length} online`;
  const list = $("userList");
  list.innerHTML = "";
  users.forEach((u) => {
    const li = document.createElement("li");
    li.append(makeAvatar(u), u.id === me?.id ? `${u.name} (you)` : u.name);
    list.append(li);
  });
});

socket.on("typing", ({ name, isTyping }) => {
  isTyping ? typingUsers.add(name) : typingUsers.delete(name);
  const names = [...typingUsers];
  typingEl.textContent = names.length
    ? `${names.join(", ")} ${names.length > 1 ? "are" : "is"} typing…`
    : "";
});

/* ---------- Rendering ---------- */
function makeAvatar(user) {
  const el = document.createElement("div");
  el.className = "avatar";
  el.style.background = user.color;
  el.textContent = user.name[0].toUpperCase();
  return el;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderMessage(msg) {
  if (msg.type === "notice") {
    const n = document.createElement("div");
    n.className = "notice";
    n.textContent = msg.text;
    messagesEl.append(n);
  } else {
    const isMe = msg.user.id === me?.id;
    const row = document.createElement("div");
    row.className = "row" + (isMe ? " me" : "");

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    if (!isMe) {
      const author = document.createElement("div");
      author.className = "author";
      author.style.color = msg.user.color;
      author.textContent = msg.user.name;
      bubble.append(author);
    }

    const text = document.createElement("span");
    text.textContent = msg.text; // textContent keeps user input safe from HTML injection
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = formatTime(msg.time);
    bubble.append(text, time);

    row.append(...(isMe ? [bubble] : [makeAvatar(msg.user), bubble]));
    messagesEl.append(row);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
