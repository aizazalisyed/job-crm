/*
 * Jarvis — a chat assistant page.
 * Type prompts, attach files (PDF, image, DOCX, TXT/code), and get streamed answers
 * from Claude using the API key already saved in Settings.
 * Conversations are stored in Firestore: users/{uid}/chats/{id}.
 * Only the text of each message and the attached file names are stored, not the raw files.
 */
window.Jarvis = (() => {
  const $ = (s, el = document) => el.querySelector(s);
  const { esc, toast } = window.JT;
  const M = window.JobMatch;

  const SYSTEM = "You are Jarvis, a helpful, direct personal assistant. Answer clearly and concisely. Use Markdown when it helps (headings, bold, lists, code blocks). When the user attaches a file, use its contents to answer.";
  const DEFAULT_MODEL = "claude-sonnet-5-5";
  const MAX_FILE = 25 * 1024 * 1024;

  // session state (in memory)
  let chats = [];          // list summaries {id, title, updatedAt}
  let chat = null;         // current {id, title, messages:[{role, text, files:[{name}], blocks}]}
  let pending = [];        // files staged for the next message [{name, type, block, kind}]
  let busy = false;
  let abort = null;
  let loaded = false;

  // ---------- data ----------
  async function loadList() {
    try { chats = (await Store.list("chats")).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")); }
    catch (e) { console.error(e); chats = []; }
  }
  function persist() {
    if (!chat) return;
    const slim = {
      id: chat.id, title: chat.title,
      messages: chat.messages.map(m => ({ role: m.role, text: m.text, files: (m.files || []).map(f => ({ name: f.name })) })),
      updatedAt: new Date().toISOString()
    };
    Store.save("chats", slim).catch(e => console.error("save chat failed", e));
    const i = chats.findIndex(c => c.id === chat.id);
    const sum = { id: chat.id, title: chat.title, updatedAt: slim.updatedAt };
    if (i >= 0) chats[i] = sum; else chats.unshift(sum);
    chats.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  }
  function newChat() { chat = { id: null, title: "New chat", messages: [] }; pending = []; }
  async function openChat(id) {
    try {
      const c = await Store.getOne("chats", id);
      if (c) { chat = { id: c.id, title: c.title || "Chat", messages: (c.messages || []).map(m => ({ ...m, blocks: null })) }; pending = []; }
    } catch (e) { console.error(e); toast("Couldn't open that chat"); }
    render();
  }
  async function deleteChat(id) {
    if (!confirm("Delete this conversation?")) return;
    try { await Store.remove("chats", id); } catch (e) { console.error(e); }
    chats = chats.filter(c => c.id !== id);
    if (chat && chat.id === id) newChat();
    render();
  }

  // ---------- files ----------
  const IMG = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  const toB64 = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(file); });

  async function stage(fileList) {
    for (const file of fileList) {
      if (file.size > MAX_FILE) { toast(`${file.name} is larger than 25 MB`); continue; }
      const ext = file.name.split(".").pop().toLowerCase();
      try {
        let block, kind;
        if (IMG[ext]) { block = { type: "image", source: { type: "base64", media_type: IMG[ext], data: await toB64(file) } }; kind = "image"; }
        else if (ext === "pdf") { block = { type: "document", source: { type: "base64", media_type: "application/pdf", data: await toB64(file) } }; kind = "pdf"; }
        else if (ext === "docx") { await M.loadScript("https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js"); const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() }); block = { type: "text", text: `Attached file ${file.name}:\n${r.value}` }; kind = "doc"; }
        else { const t = await file.text(); block = { type: "text", text: `Attached file ${file.name}:\n${t.slice(0, 200000)}` }; kind = "text"; }
        pending.push({ name: file.name, kind, block });
      } catch (e) { console.error(e); toast(`Couldn't read ${file.name}`); }
    }
    render();
  }

  // ---------- Claude streaming ----------
  function buildApiMessages() {
    return chat.messages.filter(m => m.role === "user" || (m.role === "assistant" && m.text)).map(m => {
      if (m.role === "assistant") return { role: "assistant", content: m.text };
      if (m.blocks && m.blocks.length) return { role: "user", content: m.blocks };
      // reconstructed from history (files not kept): note their names
      const note = (m.files && m.files.length) ? `\n\n[Previously attached: ${m.files.map(f => f.name).join(", ")}]` : "";
      return { role: "user", content: m.text + note };
    });
  }

  async function send(text) {
    const keys = M.getKeys();
    if (!keys.anthropicKey) { toast("Add your Claude API key in Settings first"); location.hash = "#settings"; return; }
    if ((!text || !text.trim()) && !pending.length) return;
    if (busy) return;

    const userBlocks = [];
    pending.forEach(p => userBlocks.push(p.block));
    if (text && text.trim()) userBlocks.push({ type: "text", text: text.trim() });

    const userMsg = { role: "user", text: text.trim(), files: pending.map(p => ({ name: p.name })), blocks: userBlocks };
    chat.messages.push(userMsg);
    pending = [];
    if (chat.messages.filter(m => m.role === "user").length === 1) chat.title = (text.trim() || userMsg.files.map(f => f.name).join(", ")).slice(0, 60) || "New chat";

    const assistant = { role: "assistant", text: "" };
    chat.messages.push(assistant);
    busy = true; render();

    abort = new AbortController();
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: abort.signal,
        headers: { "content-type": "application/json", "x-api-key": keys.anthropicKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model: keys.model || DEFAULT_MODEL, max_tokens: 4096, system: SYSTEM, stream: true, messages: buildApiMessages() })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data.error && data.error.message) || ("API error " + res.status));
      }
      await readStream(res, delta => { assistant.text += delta; renderStreaming(); });
      if (!assistant.text) assistant.text = "(no response)";
    } catch (e) {
      if (e.name === "AbortError") { assistant.text += assistant.text ? "\n\n_(stopped)_" : "_(stopped)_"; }
      else { console.error(e); assistant.text = "⚠️ " + e.message; }
    } finally {
      busy = false; abort = null;
      persist();
      render();
    }
  }

  async function readStream(res, onDelta) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const payload = s.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const ev = JSON.parse(payload);
          if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") onDelta(ev.delta.text);
          else if (ev.type === "error") throw new Error(ev.error && ev.error.message || "stream error");
        } catch (e) { if (e.message && !e.message.includes("JSON")) throw e; }
      }
    }
  }

  function stop() { if (abort) abort.abort(); }

  // ---------- markdown (small, safe) ----------
  function md(src) {
    const escd = esc(src);
    const blocks = escd.split(/```/);
    let out = "";
    blocks.forEach((b, i) => {
      if (i % 2) { out += `<pre><code>${b.replace(/^\w*\n/, "")}</code></pre>`; return; }
      let t = b
        .replace(/^###### (.*)$/gm, "<h6>$1</h6>").replace(/^##### (.*)$/gm, "<h5>$1</h5>")
        .replace(/^#### (.*)$/gm, "<h4>$1</h4>").replace(/^### (.*)$/gm, "<h3>$1</h3>")
        .replace(/^## (.*)$/gm, "<h2>$1</h2>").replace(/^# (.*)$/gm, "<h2>$1</h2>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      // lists
      t = t.replace(/(?:^|\n)((?:\s*[-*] .*(?:\n|$))+)/g, m => `<ul>${m.trim().split("\n").map(li => `<li>${li.replace(/^\s*[-*] /, "")}</li>`).join("")}</ul>`);
      t = t.replace(/(?:^|\n)((?:\s*\d+\. .*(?:\n|$))+)/g, m => `<ol>${m.trim().split("\n").map(li => `<li>${li.replace(/^\s*\d+\. /, "")}</li>`).join("")}</ol>`);
      t = t.replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>");
      out += `<p>${t}</p>`;
    });
    return out.replace(/<p><\/p>/g, "").replace(/<p>(<(?:ul|ol|pre|h\d)>)/g, "$1").replace(/(<\/(?:ul|ol|pre|h\d)>)<\/p>/g, "$1");
  }

  // ---------- UI ----------
  function render() {
    const view = $("#view-agent"); if (!view) return;
    if (!chat) newChat();
    const hasKey = !!M.getKeys().anthropicKey;
    const empty = chat.messages.length === 0;

    view.innerHTML = `
      <div class="jarvis">
        <div class="jv-top">
          <button class="btn" id="jvNew">＋ New chat</button>
          <select class="select" id="jvHistory" title="Your conversations">
            <option value="">History (${chats.length})</option>
            ${chats.map(c => `<option value="${esc(c.id)}" ${chat.id === c.id ? "selected" : ""}>${esc((c.title || "Chat").slice(0, 50))}</option>`).join("")}
          </select>
          ${chat.id ? `<button class="icon-btn" id="jvDelete" title="Delete this chat">🗑</button>` : ""}
        </div>

        ${!hasKey ? `<div class="notice">Add your Claude API key in <a class="link" href="#settings">Settings</a> to use Jarvis.</div>` : ""}

        <div class="jv-scroll" id="jvScroll">
          ${empty ? `
            <div class="jv-hero">
              <img src="assets/icon.svg" width="54" height="54" alt="" />
              <h2>How can I help you?</h2>
              <div class="jv-suggest">
                ${["Summarise this document", "Draft a professional email", "Explain a concept simply", "Review and improve my text"].map(s => `<button class="jv-chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join("")}
              </div>
            </div>` : `<div class="jv-messages" id="jvMessages">${chat.messages.map(msgHtml).join("")}</div>`}
        </div>

        <div class="jv-composer">
          ${pending.length ? `<div class="jv-files">${pending.map((p, i) => `<span class="jv-file">${fileIcon(p.kind)} ${esc(p.name)}<button data-unstage="${i}" aria-label="Remove">✕</button></span>`).join("")}</div>` : ""}
          <div class="jv-input-row">
            <label class="icon-btn" title="Attach files"><input type="file" id="jvFiles" multiple hidden accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.docx,.txt,.md,.csv,.json,.js,.py,.html,.css" />📎</label>
            <textarea id="jvInput" rows="1" placeholder="Message Jarvis…" ${busy ? "disabled" : ""}></textarea>
            ${busy ? `<button class="btn jv-send stop" id="jvStop" title="Stop">■</button>` : `<button class="btn primary jv-send" id="jvSend" title="Send">↑</button>`}
          </div>
          <div class="jv-hint">Jarvis can make mistakes. Check important information. Model: ${esc((M.getKeys().model || DEFAULT_MODEL).replace("claude-", "").replace(/-/g, " "))}.</div>
        </div>
      </div>`;
    bind(view);
    scrollDown();
  }

  function renderStreaming() {
    const box = $("#jvMessages");
    if (!box) return render();
    const last = box.lastElementChild;
    if (last && last.classList.contains("jv-assistant")) {
      last.querySelector(".jv-bubble").innerHTML = md(chat.messages[chat.messages.length - 1].text) + `<span class="jv-caret"></span>`;
      scrollDown();
    } else render();
  }

  function msgHtml(m) {
    if (m.role === "user") {
      return `<div class="jv-msg jv-user"><div class="jv-bubble">${m.files && m.files.length ? `<div class="jv-msg-files">${m.files.map(f => `<span class="jv-file">${esc(f.name)}</span>`).join("")}</div>` : ""}${esc(m.text).replace(/\n/g, "<br>")}</div></div>`;
    }
    return `<div class="jv-msg jv-assistant"><div class="jv-avatar"><img src="assets/icon.svg" width="24" height="24" alt=""></div><div class="jv-bubble">${m.text ? md(m.text) : `<span class="jv-typing"><span></span><span></span><span></span></span>`}</div></div>`;
  }
  const fileIcon = k => k === "image" ? "🖼" : k === "pdf" ? "📄" : "📎";

  function autosize(ta) { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 200) + "px"; }
  function scrollDown() { const s = $("#jvScroll"); if (s) s.scrollTop = s.scrollHeight; }

  function bind(view) {
    const run = fn => (...a) => { try { const r = fn(...a); if (r && r.catch) r.catch(e => { console.error(e); toast(e.message); }); } catch (e) { console.error(e); toast(e.message); } };
    $("#jvNew", view).onclick = () => { newChat(); render(); };
    $("#jvHistory", view).onchange = e => { if (e.target.value) openChat(e.target.value); };
    const del = $("#jvDelete", view); if (del) del.onclick = run(() => deleteChat(chat.id));
    const files = $("#jvFiles", view); if (files) files.onchange = run(e => stage(e.target.files));
    view.querySelectorAll("[data-unstage]").forEach(b => b.onclick = () => { pending.splice(Number(b.dataset.unstage), 1); render(); });
    view.querySelectorAll("[data-suggest]").forEach(b => b.onclick = () => { const ta = $("#jvInput"); ta.value = b.dataset.suggest; ta.focus(); autosize(ta); });
    const ta = $("#jvInput", view);
    if (ta) {
      ta.oninput = () => autosize(ta);
      ta.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const v = ta.value; ta.value = ""; run(send)(v); } };
      if (!busy) setTimeout(() => ta.focus(), 20);
    }
    const sendBtn = $("#jvSend", view); if (sendBtn) sendBtn.onclick = run(() => { const v = $("#jvInput").value; $("#jvInput").value = ""; return send(v); });
    const stopBtn = $("#jvStop", view); if (stopBtn) stopBtn.onclick = stop;
    // drag & drop
    const scroll = $("#jvScroll", view);
    if (scroll) {
      scroll.ondragover = e => { e.preventDefault(); scroll.classList.add("drag"); };
      scroll.ondragleave = () => scroll.classList.remove("drag");
      scroll.ondrop = run(e => { e.preventDefault(); scroll.classList.remove("drag"); return stage(e.dataTransfer.files); });
    }
  }

  async function onShow() {
    if (!loaded && M.getKeys().anthropicKey !== undefined) { await loadList(); loaded = true; }
    render();
  }
  function reset() { chats = []; chat = null; pending = []; loaded = false; }

  return { render: onShow, reset };
})();
