const socket = io();
const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const msgInput = $("msgInput");

let me = loadJson("friendchat.profile"); // { name, avatar } saved in this browser
let token = localStorage.getItem("friendchat.token"); // secret that proves who you are
let myId = null;
let groups = []; // groups I belong to: { id, name, count }
let current = null; // open group: { id, name, adminId, members, invite, messages }
let draftAvatar = null;
let lastMembersKey = "";
let pendingInvite = location.pathname.match(/^\/join\/([\w-]+)/)?.[1] || null;
const typingIds = new Set();
let typingTimeout = null;

/* ---------- Small helpers ---------- */
function loadJson(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
// Build a DOM element: el("button", { textContent: "Hi" }, child1, child2)
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
// Send an event to the server and wait for its answer
const ask = (event, ...args) =>
  new Promise((resolve) =>
    socket.timeout(8000).emit(event, ...args, (err, res) =>
      resolve(err ? { error: "No answer from the server. Try again." } : res || {})));

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(t.timer);
  t.timer = setTimeout(() => t.classList.remove("show"), 3000);
}
function openSheet(...nodes) {
  $("sheetCard").replaceChildren(...nodes);
  $("sheet").classList.remove("hidden");
}
const closeSheet = () => $("sheet").classList.add("hidden");
$("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
const member = (id) => current?.members.find((m) => m.id === id);

/* ---------- Pictures: shrink before sending ---------- */
function resizeImage(file, size, square) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let sx = 0, sy = 0, sw = img.width, sh = img.height, w = img.width, h = img.height;
      if (square) {
        const s = Math.min(img.width, img.height);
        sx = (img.width - s) / 2; sy = (img.height - s) / 2; sw = s; sh = s; w = size; h = size;
      } else {
        const scale = Math.min(1, size / Math.max(img.width, img.height));
        w = Math.round(img.width * scale); h = Math.round(img.height * scale);
      }
      const canvas = el("canvas", { width: w, height: h });
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
  e.target.value = "";
  if (!file) return;
  draftAvatar = await resizeImage(file, 160, true);
  showPreview();
});
$("profileForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const isNew = !me;
  me = { name: $("nameInput").value.trim(), avatar: draftAvatar };
  localStorage.setItem("friendchat.profile", JSON.stringify(me));
  $("profileModal").classList.add("hidden");
  renderMeButton();
  if (isNew) authenticate();
  else { socket.emit("profile", me); renderMessages(); }
});
$("cancelBtn").addEventListener("click", () => $("profileModal").classList.add("hidden"));
$("profileBtn").addEventListener("click", () => openProfile(true));

/* ---------- Connection ---------- */
async function authenticate() {
  if (!me || !socket.connected) return;
  const res = await ask("auth", { token, profile: me });
  if (res.error) return toast(res.error);
  token = res.token;
  myId = res.user.id;
  localStorage.setItem("friendchat.token", token);
  renderMeButton();
  if (pendingInvite) {
    const t = pendingInvite;
    pendingInvite = null;
    history.replaceState(null, "", "/");
    await handleInvite(t);
    if (!current && groups.length) openGroup(groups[0].id);
  } else if (current) {
    openGroup(current.id); // reconnected: reload the open group
  }
}
socket.on("connect", authenticate);

socket.on("groups", (list) => {
  groups = list;
  if (current && !list.some((g) => g.id === current.id)) current = null;
  if (!current && list.length && !pendingInvite) openGroup(list[0].id);
  else if (!current) renderAll();
  else renderGroups();
});

socket.on("group", (info) => {
  if (current?.id !== info.id) return;
  current = { ...current, ...info };
  renderHeader();
  renderMembers();
  // Only redraw messages when someone's name, picture or membership changed
  const key = JSON.stringify(info.members.map((m) => [m.id, m.name, m.avatar]));
  if (key !== lastMembersKey) renderMessages();
  lastMembersKey = key;
});

socket.on("message", (msg) => {
  if (msg.groupId !== current?.id) return;
  current.messages.push(msg);
  messagesEl.querySelector(".empty")?.remove();
  messagesEl.append(buildMessage(msg));
  scrollToBottom();
});

socket.on("typing", ({ groupId, userId, isTyping }) => {
  if (groupId !== current?.id) return;
  isTyping ? typingIds.add(userId) : typingIds.delete(userId);
  renderHeader();
});

/* ---------- Groups ---------- */
async function openGroup(id) {
  messagesEl.replaceChildren(el("div", { className: "empty", textContent: "Loading…" }));
  const res = await ask("group:open", id);
  if (res.error) {
    toast(res.error);
    current = null;
    return renderAll();
  }
  current = { ...res.group, invite: res.invite, messages: res.messages };
  lastMembersKey = JSON.stringify(current.members.map((m) => [m.id, m.name, m.avatar]));
  typingIds.clear();
  $("sidebar").classList.remove("open");
  renderAll();
}

function newGroupSheet() {
  const input = el("input", { placeholder: "Group name", maxLength: 30, required: true, autocomplete: "off" });
  const form = el("form", { className: "stack" },
    el("h1", { textContent: "New group" }),
    el("p", { className: "label", textContent: "You'll be the admin and can invite friends with a link." }),
    input,
    el("button", { type: "submit", textContent: "Create group" }),
    el("button", { type: "button", className: "ghost", textContent: "Cancel", onclick: closeSheet }));
  form.onsubmit = async (e) => {
    e.preventDefault();
    const res = await ask("group:create", input.value);
    if (res.error) return toast(res.error);
    closeSheet();
    openGroup(res.id);
  };
  openSheet(form);
  input.focus();
}

async function handleInvite(inviteToken) {
  const res = await ask("invite:preview", inviteToken);
  if (res.error) return toast(res.error);
  if (res.member) return openGroup(res.groupId); // already in: open it directly
  openSheet(
    el("h1", { textContent: "You're invited" }),
    el("p", { className: "label", textContent: `${res.name} · ${res.count} ${res.count === 1 ? "member" : "members"}` }),
    el("button", {
      textContent: "Join group",
      onclick: async () => {
        const r = await ask("invite:join", inviteToken);
        if (r.error) return toast(r.error);
        closeSheet();
        openGroup(r.id);
      },
    }),
    el("button", { className: "ghost", textContent: "Not now", onclick: closeSheet }));
}

const inviteUrl = () => `${location.origin}/join/${current.invite}`;
async function copyLink() {
  try { await navigator.clipboard.writeText(inviteUrl()); toast("Link copied"); }
  catch { prompt("Copy this link:", inviteUrl()); }
}
async function inviteAction(event) {
  const res = await ask(event, current.id);
  if (res.error) return toast(res.error);
  current.invite = res.invite;
  manageSheet();
}

function manageSheet() {
  const g = current;
  const isAdmin = g.adminId === myId;
  const nodes = [];

  if (isAdmin) {
    const name = el("input", { value: g.name, maxLength: 30, required: true, autocomplete: "off" });
    const form = el("form", { className: "stack" },
      el("h1", { textContent: "Group settings" }), name,
      el("button", { type: "submit", textContent: "Save name" }));
    form.onsubmit = async (e) => {
      e.preventDefault();
      const res = await ask("group:rename", g.id, name.value);
      toast(res.error || "Saved");
    };
    nodes.push(form);
  } else {
    nodes.push(el("h1", { textContent: g.name }));
  }

  nodes.push(el("p", { className: "label", textContent: `${g.members.length} members` }),
    el("ul", { className: "members" }, ...g.members.map((m) =>
      el("li", {}, makeAvatar(m.id, m), m.id === myId ? `${m.name} (you)` : m.name,
        ...(m.id === g.adminId ? [el("span", { className: "badge", textContent: "Admin" })] : [])))));

  if (isAdmin) {
    nodes.push(el("p", { className: "label", textContent: "Invitation link" }),
      el("input", { readOnly: true, value: g.invite ? inviteUrl() : "No active link", onfocus: (e) => e.target.select() }),
      el("div", { className: "row-btns" },
        el("button", { textContent: "Copy", disabled: !g.invite, onclick: copyLink }),
        el("button", { className: "ghost", textContent: g.invite ? "New link" : "Create link", onclick: () => inviteAction("invite:new") }),
        ...(g.invite ? [el("button", { className: "ghost", textContent: "Revoke", onclick: () => inviteAction("invite:revoke") })] : [])));
  }

  nodes.push(
    el("button", {
      className: "danger", textContent: "Leave group",
      onclick: async () => {
        const note = isAdmin && g.members.length > 1 ? " Another member will become the admin." : "";
        if (!confirm(`Leave "${g.name}"?${note}`)) return;
        const res = await ask("group:leave", g.id);
        if (res.error) return toast(res.error);
        closeSheet();
      },
    }),
    el("button", { className: "ghost", textContent: "Close", onclick: closeSheet }));
  openSheet(...nodes);
}

$("newGroupBtn").addEventListener("click", newGroupSheet);
$("manageBtn").addEventListener("click", () => current && manageSheet());
$("menuBtn").addEventListener("click", () => $("sidebar").classList.toggle("open"));

/* ---------- Sending ---------- */
function send(text, image) {
  if (!current) return;
  socket.emit("message", { groupId: current.id, text, image });
  socket.emit("typing", { groupId: current.id, isTyping: false });
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
  if (image.length > 700000) return toast("That picture is too big. Try a smaller one.");
  send(msgInput.value.trim(), image); // anything typed becomes the caption
  msgInput.value = "";
});
msgInput.addEventListener("input", () => {
  if (!current) return;
  socket.emit("typing", { groupId: current.id, isTyping: true });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit("typing", { groupId: current.id, isTyping: false }), 1500);
});

/* ---------- Rendering ---------- */
function colorFor(id) {
  let hue = 0;
  for (const ch of id) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hue} 70% 70%)`;
}
function makeAvatar(userId, profile) {
  const node = el("div", { className: "avatar" });
  if (profile?.avatar) node.append(el("img", { src: profile.avatar, alt: "" }));
  else {
    node.style.background = colorFor(userId);
    node.textContent = (profile?.name || "?")[0].toUpperCase();
  }
  return node;
}
function renderMeButton() {
  if (!me) return;
  $("profileBtn").replaceChildren(makeAvatar(myId || "me", me), el("span", { textContent: me.name }));
}

function renderAll() {
  renderGroups();
  renderHeader();
  renderMembers();
  renderMessages();
}

function renderGroups() {
  $("groupList").replaceChildren(...(groups.length
    ? groups.map((g) => el("li", {}, el("button", {
        type: "button", className: g.id === current?.id ? "active" : "",
        onclick: () => openGroup(g.id),
      }, el("span", { textContent: g.name }), el("span", { className: "count", textContent: g.count }))))
    : [el("li", { className: "none", textContent: "No groups yet" })]));
}

function renderHeader() {
  $("groupTitle").textContent = current?.name || "FriendChat";
  $("manageBtn").hidden = !current;
  const names = [...typingIds].map((id) => member(id)?.name || "Someone");
  const sub = $("groupSub");
  if (names.length) sub.textContent = `${names.join(", ")} ${names.length > 1 ? "are" : "is"} typing…`;
  else sub.textContent = current ? `${current.members.length} ${current.members.length === 1 ? "member" : "members"}` : "";
  sub.classList.toggle("muted", !names.length);
  msgInput.disabled = $("photoBtn").disabled = !current;
  $("composer").classList.toggle("disabled", !current);
}

function renderMembers() {
  $("memberLabel").hidden = !current;
  const sorted = [...(current?.members || [])].sort((a, b) => b.online - a.online);
  $("userList").replaceChildren(...sorted.map((m) =>
    el("li", { className: m.online ? "on" : "off" }, makeAvatar(m.id, m),
      m.id === myId ? `${m.name} (you)` : m.name,
      ...(m.id === current.adminId ? [el("span", { className: "badge", textContent: "Admin" })] : []))));
}

const formatTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function buildMessage(msg) {
  const isMe = msg.userId === myId;
  const author = member(msg.userId) || { name: "Former member" };

  const row = el("div", { className: "row" + (isMe ? " me" : "") });
  const bubble = el("div", { className: "bubble" });
  if (!isMe) bubble.append(el("div", { className: "author", textContent: author.name }));

  if (msg.image) {
    bubble.append(el("img", {
      className: "chat-img", src: msg.image, alt: "Picture sent in the chat",
      onload: scrollToBottom,
      onclick: () => { $("lightboxImg").src = msg.image; $("lightbox").classList.remove("hidden"); },
    }));
  }
  if (msg.text) bubble.append(el("div", { textContent: msg.text })); // textContent keeps input safe from HTML injection
  bubble.append(el("span", { className: "time", textContent: formatTime(msg.time) }));

  row.append(...(isMe ? [bubble] : [makeAvatar(msg.userId, author), bubble]));
  return row;
}

function renderMessages() {
  if (!current) {
    messagesEl.replaceChildren(el("div", { className: "empty",
      textContent: "Create a group with the ＋ button, or open an invite link from a friend." }));
  } else if (!current.messages.length) {
    messagesEl.replaceChildren(el("div", { className: "empty", textContent: "No messages yet. Say hi 👋" }));
  } else {
    messagesEl.replaceChildren(...current.messages.map(buildMessage));
  }
  scrollToBottom();
}
const scrollToBottom = () => { messagesEl.scrollTop = messagesEl.scrollHeight; };
$("lightbox").addEventListener("click", () => $("lightbox").classList.add("hidden"));

/* ---------- Start ---------- */
if (me) renderMeButton();
else openProfile(false);
renderAll();