const socket = io();
const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const msgInput = $("msgInput");

let me = loadProfile(); // { id, name, avatar } saved in this browser
let people = new Map(); // userId -> profile (everyone the server knows)
let online = new Set();
let history = [];
let draftAvatar = null; // picture chosen in the profile form
let lastProfilesKey = "";
const typingIds = new Set();
let typingTimeout = null;

/* ---------- Saved profile (stays after refresh) ---------- */
function loadProfile() {
  try { return JSON.parse(localStorage.getItem("friendchat.profile")); } catch { return null; }
}
function saveProfile(profile) {
  localStorage.setItem("friendchat.profile", JSON.stringify(profile));
}
function newId() {
  return crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/* ---------- Pictures: shrink before sending ---------- */
function resizeImage(file, size, square) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let sx = 0, sy = 0, sw = img.width, sh = img.height;
      let w = img.width, h = img.height;
      if (square) {
        const s = Math.min(img.width, img.height);
        sx = (img.width - s) / 2; sy = (img.height - s) / 2; sw = s; sh = s;
        w = size; h = size;
      } else {
        const scale = Math.min(1, size / Math.max(img.width, img.height));
        w = Math.round(img.width * scale); h = Math.round(img.height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", 0.75));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

/* ---------- Profile form (create + edit) ---------- */
function openProfile(isEdit) {
  draftAvatar = me?.avatar || null;
  $("profileTitle").textContent = isEdit ? "Edit your profile" : "Create your profile";
  $("saveBtn").textContent = isEdit ? "Save changes" : "Join the chat";
  $("cancelBtn").hidden = !isEdit;
  $("nameInput").value = me?.name || "";
  showPreview();
  $("profileModal").classList.remove("hidden");
  $("nameInput").focus();
}

function showPreview() {
  $("avatarPreview").hidden = !draftAvatar;
  $("avatarHint").hidden = !!draftAvatar;
  if (draftAvatar) $("avatarPreview").src = draftAvatar;
}

$("avatarInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  draftAvatar = await resizeImage(file, 160, true);
  showPreview();
  e.target.value = "";
});

$("profileForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const isNew = !me;
  me = { id: me?.id || newId(), name: $("nameInput").value.trim(), avatar: draftAvatar };
  saveProfile(me);
  socket.emit(isNew ? "join" : "profile", me);
  $("profileModal").classList.add("hidden");
  renderMeButton();
  msgInput.focus();
});

$("cancelBtn").addEventListener("click", () => $("profileModal").classList.add("hidden"));
$("profileBtn").addEventListener("click", () => openProfile(true));

/* ---------- Connection ---------- */
socket.on("connect", () => {
  if (me) socket.emit("join", me); // also runs after a refresh or reconnect
});

socket.on("welcome", (messages) => {
  history = messages;
  renderMessages();
});

socket.on("people", ({ profiles, online: onlineIds }) => {
  people = new Map(profiles.map((p) => [p.id, p]));
  online = new Set(onlineIds);
  renderPeople();
  renderMeButton();
  // Only redraw messages when someone's name or picture actually changed
  const key = JSON.stringify(profiles);
  if (key !== lastProfilesKey) renderMessages();
  lastProfilesKey = key;
});

socket.on("message", (msg) => {
  history.push(msg);
  messagesEl.append(buildMessage(msg));
  scrollToBottom();
});

socket.on("typing", ({ userId, isTyping }) => {
  isTyping ? typingIds.add(userId) : typingIds.delete(userId);
  const names = [...typingIds].map((id) => people.get(id)?.name || "Someone");
  $("typing").textContent = names.length
    ? `${names.join(", ")} ${names.length > 1 ? "are" : "is"} typing…`
    : "";
});

/* ---------- Sending ---------- */
function send(text, image) {
  socket.emit("message", { text, image });
  socket.emit("typing", false);
}

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text) return;
  send(text, null);
  msgInput.value = "";
});

$("photoBtn").addEventListener("click", () => $("photoInput").click());

$("photoInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const image = await resizeImage(file, 800, false);
  if (image.length > 700000) return alert("That picture is too big. Try a smaller one.");
  send(msgInput.value.trim(), image); // anything typed becomes the caption
  msgInput.value = "";
});

msgInput.addEventListener("input", () => {
  socket.emit("typing", true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit("typing", false), 1500);
});

/* ---------- Rendering ---------- */
function colorFor(id) {
  let hue = 0;
  for (const ch of id) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hue} 70% 70%)`;
}

function makeAvatar(userId, profile = people.get(userId)) {
  const el = document.createElement("div");
  el.className = "avatar";
  if (profile?.avatar) {
    const img = document.createElement("img");
    img.src = profile.avatar;
    img.alt = "";
    el.append(img);
  } else {
    el.style.background = colorFor(userId);
    el.textContent = (profile?.name || "?")[0].toUpperCase();
  }
  return el;
}

function renderMeButton() {
  if (!me) return;
  const name = document.createElement("span");
  name.textContent = me.name;
  $("profileBtn").replaceChildren(makeAvatar(me.id, me), name);
}

function renderPeople() {
  $("onlineCount").textContent = `${online.size} online`;
  const sorted = [...people.values()].sort((a, b) => online.has(b.id) - online.has(a.id));
  $("userList").replaceChildren(
    ...sorted.map((p) => {
      const li = document.createElement("li");
      li.className = online.has(p.id) ? "on" : "off";
      li.append(makeAvatar(p.id, p), p.id === me?.id ? `${p.name} (you)` : p.name);
      return li;
    })
  );
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function buildMessage(msg) {
  const isMe = msg.userId === me?.id;
  const profile = people.get(msg.userId);

  const row = document.createElement("div");
  row.className = "row" + (isMe ? " me" : "");

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (!isMe) {
    const author = document.createElement("div");
    author.className = "author";
    author.textContent = profile?.name || "Someone";
    bubble.append(author);
  }

  if (msg.image) {
    const img = document.createElement("img");
    img.className = "chat-img";
    img.src = msg.image;
    img.alt = "Picture sent in the chat";
    img.addEventListener("load", scrollToBottom);
    img.addEventListener("click", () => {
      $("lightboxImg").src = msg.image;
      $("lightbox").classList.remove("hidden");
    });
    bubble.append(img);
  }

  if (msg.text) {
    const text = document.createElement("div");
    text.textContent = msg.text; // textContent keeps user input safe from HTML injection
    bubble.append(text);
  }

  const time = document.createElement("span");
  time.className = "time";
  time.textContent = formatTime(msg.time);
  bubble.append(time);

  row.append(...(isMe ? [bubble] : [makeAvatar(msg.userId), bubble]));
  return row;
}

function renderMessages() {
  messagesEl.replaceChildren(...history.map(buildMessage));
  scrollToBottom();
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

$("lightbox").addEventListener("click", () => $("lightbox").classList.add("hidden"));

/* ---------- Start ---------- */
if (me) renderMeButton();
else openProfile(false);
