const list = document.querySelector("#chat-list");
const timeline = document.querySelector("#timeline");
const summary = document.querySelector("#summary");
const title = document.querySelector("#header-title");
const subtitle = document.querySelector("#header-subtitle");
const icon = document.querySelector("#header-icon");
const notice = document.querySelector("#notice");
const jsonLink = document.querySelector("#json-link");
const shell = document.querySelector(".shell");
let chats = [];
let selected = null;
let filter = "all";
let search = "";
let oldest = null;
let hasMore = false;
let ownUserId = null;

async function load() {
  const [chatResponse, summaryResponse] = await Promise.all([
    fetch("/api/chats"),
    fetch("/api/summary"),
  ]);
  chats = await chatResponse.json();
  const info = await summaryResponse.json();
  ownUserId = info.ownUserId || null;
  document.querySelector("#chat-total").textContent = `${info.chats} Chats`;
  summary.textContent = `${info.messages.toLocaleString("de-DE")} Nachrichten · ${info.files.toLocaleString("de-DE")} Dateien${info.failed ? ` · ${info.failed} prüfen` : ""}`;
  renderList();
  const [type, id] = location.hash.slice(1).split("/");
  if (type && id) selectChat(type, id);
}

function renderList() {
  list.replaceChildren();
  const visible = chats.filter(
    (chat) =>
      (filter === "all" || chat.type === filter) &&
      chat.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  for (const type of ["channel", "conversation"]) {
    const group = visible.filter((chat) => chat.type === type);
    if (!group.length) continue;
    const heading = document.createElement("div");
    heading.className = "chat-group";
    heading.textContent = `${type === "channel" ? "Channels" : "Konversationen"} · ${group.length}`;
    list.append(heading);
    for (const chat of group) list.append(chatRow(chat));
  }
}

function chatRow(chat) {
  const row = document.createElement("button");
  row.className = `chat-row${selected?.id === chat.id && selected?.type === chat.type ? " selected" : ""}`;
  row.type = "button";
  const badge = document.createElement("span");
  badge.className = `chat-icon ${chat.type}`;
  badge.textContent = chat.type === "channel" ? "#" : initials(chat.title);
  if (chat.avatar_hash) {
    badge.textContent = "";
    const image = document.createElement("img");
    image.src = `/media/${chat.avatar_hash}`;
    image.alt = "";
    badge.append(image);
  }
  const meta = document.createElement("span");
  meta.className = "chat-meta";
  const name = document.createElement("span");
  name.className = "chat-name";
  name.textContent = chat.title;
  const detail = document.createElement("div");
  detail.className = "chat-detail";
  detail.textContent = `${chat.message_count} Nachrichten${chat.archived ? " · archiviert" : ""}${chat.import_state === "failed" ? " · Importfehler" : ""}`;
  meta.append(name, detail);
  const date = document.createElement("span");
  date.className = "chat-date";
  date.textContent = chat.latest_at ? formatShortDate(chat.latest_at) : "";
  row.append(badge, meta, date);
  row.addEventListener("click", () => selectChat(chat.type, chat.id));
  return row;
}

async function selectChat(type, id) {
  const chat = chats.find((item) => item.type === type && item.id === id);
  if (!chat) return;
  selected = chat;
  location.hash = `${type}/${id}`;
  shell.classList.add("chat-open");
  renderList();
  title.textContent = `${type === "channel" ? "#" : ""}${chat.title}`;
  subtitle.textContent = `${chat.message_count} Nachrichten · ${chat.archived ? "Archiviert" : "Lokal gespeichert"}`;
  icon.className = `chat-icon ${type}`;
  icon.textContent = type === "channel" ? "#" : initials(chat.title);
  jsonLink.href = `/api/chats/${type}/${encodeURIComponent(id)}/export`;
  jsonLink.classList.remove("hidden");
  notice.classList.toggle(
    "hidden",
    !["failed", "needs-review"].includes(chat.import_state),
  );
  notice.textContent = chat.import_error || "";
  timeline.replaceChildren();
  oldest = null;
  hasMore = false;
  await loadMessages();
  timeline.scrollTop = timeline.scrollHeight;
}

async function loadMessages() {
  if (!selected) return;
  const current = selected;
  const params = new URLSearchParams({ limit: "100" });
  if (oldest) {
    params.set("before", oldest.created_at || "");
    params.set("before_id", oldest.id);
  }
  const response = await fetch(
    `/api/chats/${current.type}/${encodeURIComponent(current.id)}/messages?${params}`,
  );
  const data = await response.json();
  if (selected !== current) return;
  const messages = data.messages;
  hasMore = messages.length === 100;
  if (messages.length) oldest = messages[0];
  const oldHeight = timeline.scrollHeight;
  const oldTop = timeline.scrollTop;
  const fragment = document.createDocumentFragment();
  let lastDay = "";
  for (const message of messages) {
    const day = message.created_at ? message.created_at.slice(0, 10) : "";
    if (day && day !== lastDay) {
      fragment.append(dateDivider(message.created_at));
      lastDay = day;
    }
    fragment.append(messageRow(message));
  }
  if (hasMore) {
    const button = document.createElement("button");
    button.className = "load-older";
    button.textContent = "Ältere Nachrichten laden";
    button.addEventListener("click", loadMessages);
    fragment.prepend(button);
  }
  timeline.querySelector(".load-older")?.remove();
  timeline.prepend(fragment);
  if (oldHeight)
    timeline.scrollTop = oldTop + timeline.scrollHeight - oldHeight;
  if (!messages.length && !oldHeight)
    timeline.textContent = "In diesem Chat sind keine Nachrichten gespeichert.";
}

function messageRow(message) {
  const row = document.createElement("article");
  row.className = `message${message.sender_id === ownUserId ? " own" : ""}`;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = initials(message.sender_name);
  if (message.sender_avatar) {
    const image = document.createElement("img");
    image.src = `/media/${message.sender_avatar}`;
    image.alt = "";
    avatar.replaceChildren(image);
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const sender = document.createElement("div");
  sender.className = "sender";
  sender.textContent = message.sender_name;
  const body = document.createElement("div");
  body.className = "body";
  body.textContent =
    message.decryption_state === "unverified"
      ? "[Verschlüsselter Inhalt konnte nicht verifiziert werden]"
      : message.text || "";
  bubble.append(sender, body);
  if (message.decryption_state === "unverified") {
    const warning = document.createElement("div");
    warning.className = "ciphertext";
    warning.textContent = "Im Roh-JSON bleibt der Originalwert erhalten.";
    bubble.append(warning);
  }
  if (message.files.length) bubble.append(fileList(message.files));
  const time = document.createElement("div");
  time.className = "message-time";
  time.textContent = message.created_at
    ? new Date(message.created_at).toLocaleTimeString("de-DE", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
  bubble.append(time);
  row.append(avatar, bubble);
  return row;
}

function fileList(files) {
  const container = document.createElement("div");
  container.className = "file-list";
  for (const file of files) {
    if (file.blob_hash && file.mime?.startsWith("image/")) {
      const link = document.createElement("a");
      link.href = `/media/${file.blob_hash}`;
      link.download = file.name;
      const image = document.createElement("img");
      image.className = "image-file";
      image.src = link.href;
      image.alt = file.name;
      link.append(image);
      container.append(link);
    } else {
      const link = document.createElement(file.blob_hash ? "a" : "span");
      link.className = `file${file.blob_hash ? "" : " missing"}`;
      link.textContent = `📎 ${file.name}${file.blob_hash ? "" : " · nicht verfügbar"}`;
      if (file.blob_hash) {
        link.href = `/media/${file.blob_hash}`;
        link.download = file.name;
      }
      container.append(link);
    }
  }
  return container;
}

function dateDivider(value) {
  const divider = document.createElement("div");
  divider.className = "date-divider";
  const label = document.createElement("span");
  label.textContent = new Date(value).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
  divider.append(label);
  return divider;
}

function initials(value) {
  return String(value || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || "")
    .join("")
    .toUpperCase();
}

function formatShortDate(value) {
  return new Date(value).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}

document.querySelector("#search").addEventListener("input", (event) => {
  search = event.target.value;
  renderList();
});
for (const button of document.querySelectorAll(".filter")) {
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    document.querySelector(".filter.active")?.classList.remove("active");
    button.classList.add("active");
    renderList();
  });
}
document
  .querySelector(".conversation-header")
  .addEventListener("click", (event) => {
    if (innerWidth <= 540 && event.clientX < 45)
      shell.classList.remove("chat-open");
  });
load().catch((error) => {
  summary.textContent = `Archiv konnte nicht geladen werden: ${error.message}`;
});
