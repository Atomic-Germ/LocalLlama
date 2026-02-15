const state = {
  models: [],
  running: [],
  conversations: [],
  activeId: null,
  active: null,
  abortController: null,
};

const elements = {
  status: document.getElementById("status"),
  conversationList: document.getElementById("conversation-list"),
  newChat: document.getElementById("new-chat"),
  renameChat: document.getElementById("rename-chat"),
  deleteChat: document.getElementById("delete-chat"),
  chatTitle: document.getElementById("chat-title"),
  messages: document.getElementById("messages"),
  userInput: document.getElementById("user-input"),
  sendBtn: document.getElementById("send-btn"),
  stopBtn: document.getElementById("stop-btn"),
  modelSelect: document.getElementById("model-select"),
  refreshModels: document.getElementById("refresh-models"),
  modelMeta: document.getElementById("model-meta"),
  runningList: document.getElementById("running-list"),
  pullInput: document.getElementById("pull-input"),
  pullBtn: document.getElementById("pull-btn"),
  pullLog: document.getElementById("pull-log"),
  systemInput: document.getElementById("system-input"),
  temperature: document.getElementById("temperature"),
  topP: document.getElementById("top-p"),
  topK: document.getElementById("top-k"),
  minP: document.getElementById("min-p"),
  numPredict: document.getElementById("num-predict"),
  numCtx: document.getElementById("num-ctx"),
  stop: document.getElementById("stop"),
  keepAlive: document.getElementById("keep-alive"),
  think: document.getElementById("think"),
  format: document.getElementById("format"),
  stream: document.getElementById("stream"),
};

const messageTemplate = document.getElementById("message-template");

function setStatus(text, ok) {
  elements.status.querySelector("span:last-child").textContent = text;
  elements.status.querySelector(".dot").style.background = ok ? "#4ade80" : "#999";
}

async function apiFetch(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }
  return response;
}

function renderList() {
  elements.conversationList.innerHTML = "";
  state.conversations.forEach((conv) => {
    const item = document.createElement("div");
    item.className = "list-item" + (conv.id === state.activeId ? " active" : "");
    item.textContent = conv.title;
    item.addEventListener("click", () => loadConversation(conv.id));
    elements.conversationList.appendChild(item);
  });
}

function renderMessages() {
  elements.messages.innerHTML = "";
  if (!state.active) {
    return;
  }
  state.active.messages.forEach((msg) => {
    appendMessage(msg.role, msg.content, msg.role === "tool");
  });
}

function appendMessage(role, content, isTool) {
  const node = messageTemplate.content.cloneNode(true);
  const root = node.querySelector(".message");
  if (isTool) {
    root.classList.add("tool");
  }
  node.querySelector(".message-role").textContent = role;
  node.querySelector(".message-content").textContent = content;
  elements.messages.appendChild(node);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function getSettings() {
  const stopValue = elements.stop.value.trim();
  const stopList = stopValue ? stopValue.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const formatValue = elements.format.value || undefined;
  const thinkValue = elements.think.value || undefined;
  return {
    model: elements.modelSelect.value,
    options: {
      temperature: parseFloat(elements.temperature.value),
      top_p: parseFloat(elements.topP.value),
      top_k: parseInt(elements.topK.value, 10),
      min_p: parseFloat(elements.minP.value),
      num_predict: parseInt(elements.numPredict.value, 10),
      num_ctx: parseInt(elements.numCtx.value, 10),
      stop: stopList,
    },
    keep_alive: elements.keepAlive.value || undefined,
    stream: elements.stream.checked,
    think: thinkValue,
    format: formatValue,
  };
}

async function saveConversation() {
  if (!state.active) {
    return;
  }
  const payload = {
    id: state.active.id,
    title: state.active.title,
    created_at: state.active.created_at,
    system: state.active.system,
    settings: state.active.settings,
    messages: state.active.messages,
  };
  const response = await apiFetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  state.active = data;
  await refreshConversations();
}

async function refreshConversations() {
  const response = await apiFetch("/api/conversations");
  state.conversations = await response.json();
  renderList();
}

async function loadConversation(id) {
  const response = await apiFetch(`/api/conversations/${id}`);
  state.active = await response.json();
  state.activeId = id;
  elements.chatTitle.textContent = state.active.title;
  elements.systemInput.value = state.active.system || "";
  renderList();
  renderMessages();
}

async function newConversation() {
  state.active = {
    title: "New chat",
    system: "",
    settings: {},
    messages: [],
  };
  await saveConversation();
  await loadConversation(state.active.id);
}

function buildChatPayload(userText) {
  const settings = getSettings();
  state.active.settings = settings;
  const messages = [];
  if (state.active.system) {
    messages.push({ role: "system", content: state.active.system });
  }
  state.active.messages.forEach((msg) => messages.push(msg));
  messages.push({ role: "user", content: userText });
  return {
    model: settings.model,
    messages,
    options: settings.options,
    keep_alive: settings.keep_alive,
    stream: settings.stream,
    think: settings.think,
    format: settings.format,
  };
}

async function sendMessage() {
  const text = elements.userInput.value.trim();
  if (!text || !state.active) {
    return;
  }
  elements.userInput.value = "";
  state.active.messages.push({ role: "user", content: text });
  appendMessage("user", text);

  const payload = buildChatPayload(text);
  const assistant = { role: "assistant", content: "" };
  state.active.messages.push(assistant);
  appendMessage("assistant", "");

  const messageNodes = elements.messages.querySelectorAll(".message");
  const assistantNode = messageNodes[messageNodes.length - 1].querySelector(".message-content");

  state.abortController = new AbortController();
  elements.stopBtn.disabled = false;

  try {
    const response = await apiFetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: state.abortController.signal,
    });

    if (!payload.stream) {
      const data = await response.json();
      assistant.content = data.message?.content || data.response || "";
      assistantNode.textContent = assistant.content;
      await saveConversation();
      return;
    }

    await streamNdjson(response, (chunk) => {
      if (chunk.error) {
        assistant.content += `\n[error] ${chunk.error}`;
        assistantNode.textContent = assistant.content;
        return;
      }
      if (chunk.message?.content) {
        assistant.content += chunk.message.content;
        assistantNode.textContent = assistant.content;
      }
      if (chunk.message?.thinking) {
        assistant.content += `\n\n[thinking] ${chunk.message.thinking}`;
        assistantNode.textContent = assistant.content;
      }
      if (chunk.message?.tool_calls?.length) {
        assistant.content += `\n\n[tools] ${JSON.stringify(chunk.message.tool_calls)}`;
        assistantNode.textContent = assistant.content;
      }
    });
    await saveConversation();
  } catch (error) {
    assistant.content += `\n[error] ${error.message}`;
    assistantNode.textContent = assistant.content;
  } finally {
    state.abortController = null;
    elements.stopBtn.disabled = true;
  }
}

async function streamNdjson(response, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) {
        continue;
      }
      try {
        onChunk(JSON.parse(line));
      } catch (error) {
        onChunk({ error: "Invalid stream chunk" });
      }
    }
  }
}

async function refreshModels() {
  const response = await apiFetch("/api/models");
  const data = await response.json();
  state.models = data.models || [];
  renderModels();
}

function renderModels() {
  elements.modelSelect.innerHTML = "";
  state.models.forEach((model) => {
    const option = document.createElement("option");
    option.value = model.name;
    option.textContent = model.name;
    elements.modelSelect.appendChild(option);
  });
  if (state.models[0]) {
    elements.modelSelect.value = state.models[0].name;
    updateModelMeta();
  }
}

function updateModelMeta() {
  const model = state.models.find((item) => item.name === elements.modelSelect.value);
  if (!model) {
    elements.modelMeta.textContent = "";
    return;
  }
  elements.modelMeta.textContent = `${model.details.family || ""} ${model.details.parameter_size || ""} ${model.details.quantization_level || ""}`;
}

async function refreshRunning() {
  const response = await apiFetch("/api/running");
  const data = await response.json();
  state.running = data.models || [];
  elements.runningList.innerHTML = "";
  state.running.forEach((model) => {
    const item = document.createElement("div");
    item.className = "list-item";
    item.textContent = `${model.name} (${Math.round((model.size_vram || 0) / 1024 / 1024)} MB)`;
    elements.runningList.appendChild(item);
  });
}

async function pullModel() {
  const name = elements.pullInput.value.trim();
  if (!name) {
    return;
  }
  elements.pullLog.textContent = "";
  const payload = { model: name, stream: true };
  const response = await apiFetch("/api/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await streamNdjson(response, (chunk) => {
    elements.pullLog.textContent += `${JSON.stringify(chunk)}\n`;
    elements.pullLog.scrollTop = elements.pullLog.scrollHeight;
  });
  await refreshModels();
}

function bindEvents() {
  elements.newChat.addEventListener("click", newConversation);
  elements.renameChat.addEventListener("click", async () => {
    if (!state.active) {
      return;
    }
    const title = prompt("Chat title", state.active.title);
    if (title) {
      state.active.title = title;
      elements.chatTitle.textContent = title;
      await saveConversation();
    }
  });
  elements.deleteChat.addEventListener("click", async () => {
    if (!state.activeId) {
      return;
    }
    await apiFetch(`/api/conversations/${state.activeId}`, { method: "DELETE" });
    state.activeId = null;
    state.active = null;
    elements.messages.innerHTML = "";
    elements.chatTitle.textContent = "New chat";
    await refreshConversations();
  });
  elements.sendBtn.addEventListener("click", sendMessage);
  elements.userInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      sendMessage();
    }
  });
  elements.stopBtn.addEventListener("click", () => {
    if (state.abortController) {
      state.abortController.abort();
    }
  });
  elements.refreshModels.addEventListener("click", refreshModels);
  elements.modelSelect.addEventListener("change", updateModelMeta);
  elements.pullBtn.addEventListener("click", pullModel);
  elements.systemInput.addEventListener("change", () => {
    if (!state.active) {
      return;
    }
    state.active.system = elements.systemInput.value;
    saveConversation();
  });
}

async function init() {
  bindEvents();
  try {
    await refreshModels();
    await refreshRunning();
    await refreshConversations();
    if (state.conversations.length) {
      await loadConversation(state.conversations[0].id);
    } else {
      await newConversation();
    }
    setStatus("Connected", true);
  } catch (error) {
    setStatus("Offline", false);
  }
}

init();
