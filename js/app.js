(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const stageColor = (k) => (STAGES.find(s => s.key === k) || STAGES[0]).color;
  const ACTIVE = ["Applied", "Screening", "Interview"];

  const state = { jobs: [], contacts: [], settings: { countries: [] }, search: "", sort: { key: "updatedAt", dir: -1 } };

  const VIEWS = {
    dashboard: ["Dashboard", "Your job search at a glance"],
    match: ["AI Job Match", "Upload your CV and let Claude find relevant LinkedIn jobs"],
    pipeline: ["Pipeline", "Every application by stage"],
    jobs: ["All jobs", "Filter, sort and export your applications"],
    followups: ["Follow-ups", "Who you need to chase and when"],
    contacts: ["Contacts", "People connected to your applications"],
    settings: ["Settings", "Countries, backups and backend"]
  };

  // ---------- dates ----------
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const daysFromToday = (d) => Math.round((new Date(d + "T00:00:00") - new Date(todayStr() + "T00:00:00")) / 86400000);
  const fmtDate = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
  function dateChip(d) {
    if (!d) return "";
    const n = daysFromToday(d);
    const cls = n < 0 ? "overdue" : n === 0 ? "today" : "";
    const label = n < 0 ? `${-n}d overdue` : n === 0 ? "Today" : n === 1 ? "Tomorrow" : fmtDate(d);
    return `<span class="date-chip ${cls}">${label}</span>`;
  }
  const pill = (status) => `<span class="pill"><span class="dot" style="background:${stageColor(status)}"></span>${esc(status)}</span>`;

  // ---------- data ----------
  async function load() {
    const [jobs, contacts, settings] = await Promise.all([Store.list("jobs"), Store.list("contacts"), Store.getSettings()]);
    state.jobs = jobs; state.contacts = contacts; state.settings = settings;
    document.documentElement.dataset.theme = settings.theme === "dark" ? "dark" : "light";
  }

  function matchesSearch(j) {
    if (!state.search) return true;
    const q = state.search.toLowerCase();
    return [j.title, j.company, j.country, j.city, j.notes, j.contact, j.status].some(v => (v || "").toLowerCase().includes(q));
  }

  // ---------- routing ----------
  function route() {
    const view = (location.hash || "#dashboard").slice(1);
    const v = VIEWS[view] ? view : "dashboard";
    $$(".view").forEach(el => el.classList.toggle("active", el.id === `view-${v}`));
    $$(".nav-item").forEach(el => el.classList.toggle("active", el.dataset.view === v));
    $("#viewTitle").textContent = VIEWS[v][0];
    $("#viewSubtitle").textContent = VIEWS[v][1];
    $("#sidebar").classList.remove("open");
    render();
  }

  function render() {
    renderLists();
    renderBadge();
    const v = (location.hash || "#dashboard").slice(1);
    if (v === "dashboard" || !VIEWS[v]) renderDashboard();
    if (v === "pipeline") renderKanban();
    if (v === "jobs") renderJobs();
    if (v === "followups") renderFollowups();
    if (v === "contacts") renderContacts();
    if (v === "settings") renderSettings();
    if (v === "match" && window.JobMatch) window.JobMatch.render();
  }

  function renderLists() {
    const countries = [...new Set([...state.settings.countries, ...state.jobs.map(j => j.country).filter(Boolean)])].sort();
    $("#countryList").innerHTML = countries.map(c => `<option value="${esc(c)}">`).join("");
    $("#contactList").innerHTML = state.contacts.map(c => `<option value="${esc(c.name)}">`).join("");
    for (const id of ["#fCountry", "#pipeCountry"]) {
      const sel = $(id), cur = sel.value;
      sel.innerHTML = `<option value="">All countries</option>` + countries.map(c => `<option>${esc(c)}</option>`).join("");
      sel.value = countries.includes(cur) ? cur : "";
    }
    const fs = $("#fStatus"), cur = fs.value;
    fs.innerHTML = `<option value="">All stages</option>` + STAGES.map(s => `<option>${s.key}</option>`).join("");
    fs.value = cur;
    $("#statusSelect").innerHTML = STAGES.map(s => `<option>${s.key}</option>`).join("");
  }

  function openFollowups() {
    return state.jobs.filter(j => j.followUpDate && !["Rejected", "Withdrawn", "Offer"].includes(j.status));
  }
  function renderBadge() {
    const due = openFollowups().filter(j => daysFromToday(j.followUpDate) <= 0).length;
    $("#followupBadge").textContent = due || "";
  }

  // ---------- dashboard ----------
  function renderDashboard() {
    const jobs = state.jobs.filter(matchesSearch);
    const applied = jobs.filter(j => j.status !== "Saved");
    const active = jobs.filter(j => ACTIVE.includes(j.status));
    const interviews = jobs.filter(j => ["Interview", "Offer"].includes(j.status));
    const offers = jobs.filter(j => j.status === "Offer");
    const responded = applied.filter(j => !["Applied", "Withdrawn"].includes(j.status));
    const rate = applied.length ? Math.round((responded.length / applied.length) * 100) : 0;
    const weekAgo = Date.now() - 7 * 86400000;
    const thisWeek = applied.filter(j => j.appliedDate && new Date(j.appliedDate) >= weekAgo).length;

    const kpis = [
      ["Applications", applied.length, `${thisWeek} in the last 7 days`],
      ["Active", active.length, "Applied, screening or interview"],
      ["Interviews", interviews.length, "Reached interview stage or beyond"],
      ["Offers", offers.length, offers.length ? "Nice work" : "Keep going"],
      ["Response rate", rate + "%", "Applications that got a reply"]
    ];
    $("#kpis").innerHTML = kpis.map(([l, v, s]) => `<div class="kpi"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div><div class="kpi-sub">${s}</div></div>`).join("");

    // stage chart
    const stageCounts = STAGES.map(s => ({ label: s.key, n: jobs.filter(j => j.status === s.key).length, color: s.color }));
    barList("#stageChart", stageCounts);

    // country chart
    const byCountry = {};
    applied.forEach(j => { byCountry[j.country] = (byCountry[j.country] || 0) + 1; });
    const cc = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, n]) => ({ label, n, color: "var(--primary)" }));
    barList("#countryChart", cc);

    // weekly chart
    const weeks = [];
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - start.getDay() + 1); // Monday
    for (let i = 7; i >= 0; i--) {
      const ws = new Date(start); ws.setDate(start.getDate() - i * 7);
      const we = new Date(ws); we.setDate(ws.getDate() + 7);
      const n = applied.filter(j => { if (!j.appliedDate) return false; const d = new Date(j.appliedDate + "T00:00:00"); return d >= ws && d < we; }).length;
      weeks.push({ label: ws.toLocaleDateString(undefined, { day: "numeric", month: "short" }), n });
    }
    const max = Math.max(1, ...weeks.map(w => w.n));
    $("#weeklyChart").innerHTML = weeks.map(w => `<div class="wk" title="Week of ${w.label}: ${w.n}"><div class="wk-num">${w.n || ""}</div><div class="wk-bar" style="height:${(w.n / max) * 130}px"></div><div class="wk-label">${w.label}</div></div>`).join("");

    // upcoming
    const up = openFollowups().filter(matchesSearch).sort((a, b) => a.followUpDate.localeCompare(b.followUpDate)).slice(0, 6);
    $("#upcomingList").innerHTML = up.length ? up.map(jobLi).join("") : `<div class="empty">No follow-ups scheduled</div>`;

    // top table
    const top = jobs.filter(j => !["Rejected", "Withdrawn"].includes(j.status)).sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0)).slice(0, 6);
    $("#topTable").innerHTML = tableHtml(top, ["role", "country", "status", "fitScore", "visa"], false);
  }

  function barList(sel, rows) {
    const max = Math.max(1, ...rows.map(r => r.n));
    $(sel).innerHTML = rows.length && rows.some(r => r.n)
      ? rows.map(r => `<div class="bar-row"><span>${esc(r.label)}</span><div class="bar-track"><div class="bar-fill" style="width:${(r.n / max) * 100}%;background:${r.color}"></div></div><span class="bar-num">${r.n}</span></div>`).join("")
      : `<div class="empty">No data yet</div>`;
  }

  function jobLi(j) {
    return `<li data-job="${j.id}"><div class="li-main"><div class="li-title">${esc(j.title)} · ${esc(j.company)}</div><div class="li-sub">${esc(j.country)}${j.contact ? " · " + esc(j.contact) : ""}</div></div>${pill(j.status)}${dateChip(j.followUpDate)}</li>`;
  }

  // ---------- table ----------
  const COLS = {
    role: ["Role", "title", j => `<div class="cell-title">${esc(j.title)}</div><div class="cell-sub">${esc(j.company)}</div>`],
    country: ["Location", "country", j => `${esc(j.country)}${j.city ? `<div class="cell-sub">${esc(j.city)}</div>` : ""}`],
    status: ["Stage", "status", j => pill(j.status)],
    priority: ["Priority", "priority", j => `<span class="prio-${esc(j.priority)}">● ${esc(j.priority)}</span>`],
    fitScore: ["Fit", "fitScore", j => j.fitScore ? `<span class="score">${j.fitScore}</span>/10` : "–"],
    visa: ["Visa", "visa", j => j.visa ? `<span class="visa-yes">Yes</span>` : `<span class="cell-sub">No</span>`],
    workMode: ["Mode", "workMode", j => esc(j.workMode)],
    appliedDate: ["Applied", "appliedDate", j => fmtDate(j.appliedDate) || "–"],
    followUpDate: ["Follow-up", "followUpDate", j => dateChip(j.followUpDate) || "–"],
    source: ["Source", "source", j => esc(j.source)],
    link: ["", "link", j => j.link ? `<a class="link" href="${esc(j.link)}" target="_blank" rel="noopener" data-stop>Open ↗</a>` : ""]
  };

  function tableHtml(rows, cols, sortable = true) {
    if (!rows.length) return `<tbody><tr><td><div class="empty">No jobs match</div></td></tr></tbody>`;
    const head = cols.map(c => {
      const [label, key] = COLS[c];
      const arrow = sortable && state.sort.key === key ? (state.sort.dir > 0 ? " ↑" : " ↓") : "";
      return `<th ${sortable ? `data-sort="${key}"` : ""}>${label}${arrow}</th>`;
    }).join("");
    const body = rows.map(j => `<tr data-job="${j.id}">${cols.map(c => `<td>${COLS[c][2](j)}</td>`).join("")}</tr>`).join("");
    return `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
  }

  function filteredJobs() {
    const st = $("#fStatus").value, co = $("#fCountry").value, pr = $("#fPriority").value, visa = $("#fVisa").checked;
    const { key, dir } = state.sort;
    return state.jobs
      .filter(j => matchesSearch(j) && (!st || j.status === st) && (!co || j.country === co) && (!pr || j.priority === pr) && (!visa || j.visa))
      .sort((a, b) => {
        const x = a[key] ?? "", y = b[key] ?? "";
        return (typeof x === "number" || typeof y === "number" ? (Number(x) || 0) - (Number(y) || 0) : String(x).localeCompare(String(y))) * dir;
      });
  }
  function renderJobs() {
    $("#jobsTable").innerHTML = tableHtml(filteredJobs(), ["role", "country", "status", "priority", "fitScore", "visa", "workMode", "appliedDate", "followUpDate", "source", "link"]);
  }

  // ---------- kanban ----------
  function renderKanban() {
    const co = $("#pipeCountry").value;
    const jobs = state.jobs.filter(j => matchesSearch(j) && (!co || j.country === co));
    $("#kanban").innerHTML = STAGES.map(s => {
      const items = jobs.filter(j => j.status === s.key);
      return `<div class="col" data-stage="${s.key}">
        <div class="col-head"><span class="pill" style="padding:0;background:none"><span class="dot" style="background:${s.color}"></span></span>${s.key}<span class="count">${items.length}</span></div>
        ${items.map(j => `<div class="kcard" draggable="true" data-job="${j.id}">
          <div class="kcard-title">${esc(j.title)}</div>
          <div class="kcard-sub">${esc(j.company)} · ${esc(j.country)}</div>
          <div class="kcard-meta">
            ${j.fitScore ? `<span class="tag">Fit ${j.fitScore}/10</span>` : ""}
            <span class="tag prio-${esc(j.priority)}">${esc(j.priority)}</span>
            ${j.visa ? `<span class="tag visa-yes">Visa</span>` : ""}
            ${j.followUpDate ? dateChip(j.followUpDate) : ""}
          </div></div>`).join("")}
      </div>`;
    }).join("");
  }

  function bindKanbanDnD() {
    const k = $("#kanban");
    k.addEventListener("dragstart", e => {
      const c = e.target.closest(".kcard"); if (!c) return;
      e.dataTransfer.setData("text/plain", c.dataset.job); c.classList.add("dragging");
    });
    k.addEventListener("dragend", e => { const c = e.target.closest(".kcard"); if (c) c.classList.remove("dragging"); });
    k.addEventListener("dragover", e => { const col = e.target.closest(".col"); if (col) { e.preventDefault(); $$(".col", k).forEach(x => x.classList.toggle("drag-over", x === col)); } });
    k.addEventListener("dragleave", e => { if (!k.contains(e.relatedTarget)) $$(".col", k).forEach(x => x.classList.remove("drag-over")); });
    k.addEventListener("drop", async e => {
      const col = e.target.closest(".col"); if (!col) return;
      e.preventDefault();
      const id = e.dataTransfer.getData("text/plain");
      const job = state.jobs.find(j => j.id === id);
      if (job && job.status !== col.dataset.stage) {
        const patch = { ...job, status: col.dataset.stage };
        if (patch.status === "Applied" && !patch.appliedDate) patch.appliedDate = todayStr();
        await Store.save("jobs", patch);
        state.jobs = await Store.list("jobs");
        toast(`Moved to ${col.dataset.stage}`);
      }
      render();
    });
  }

  // ---------- follow-ups ----------
  function renderFollowups() {
    const all = openFollowups().filter(matchesSearch).sort((a, b) => a.followUpDate.localeCompare(b.followUpDate));
    const groups = [
      ["Overdue", all.filter(j => daysFromToday(j.followUpDate) < 0)],
      ["Today and this week", all.filter(j => { const n = daysFromToday(j.followUpDate); return n >= 0 && n <= 7; })],
      ["Later", all.filter(j => daysFromToday(j.followUpDate) > 7)]
    ];
    $("#followupCols").innerHTML = groups.map(([t, items]) => `<div class="card fu-col"><div class="card-head"><h3>${t}</h3><span class="hint">${items.length}</span></div>
      <ul class="list">${items.length ? items.map(jobLi).join("") : `<div class="empty">Nothing here</div>`}</ul></div>`).join("");
  }

  // ---------- contacts ----------
  function renderContacts() {
    const q = state.search.toLowerCase();
    const list = state.contacts.filter(c => !q || [c.name, c.company, c.role].some(v => (v || "").toLowerCase().includes(q)));
    $("#contactsGrid").innerHTML = list.length ? list.map(c => {
      const linked = state.jobs.filter(j => j.contact === c.name).length;
      const initials = c.name.split(/\s+/).map(p => p[0]).slice(0, 2).join("").toUpperCase();
      return `<div class="card contact" data-contact="${c.id}">
        <div class="contact-top"><div class="avatar">${esc(initials)}</div><div><div class="contact-name">${esc(c.name)}</div><div class="contact-role">${esc(c.role)}${c.company ? " at " + esc(c.company) : ""}</div></div></div>
        ${c.email ? `<div class="contact-line">✉ ${esc(c.email)}</div>` : ""}
        ${c.linkedin ? `<div class="contact-line">in <a class="link" href="${esc(c.linkedin)}" target="_blank" rel="noopener" data-stop>LinkedIn profile</a></div>` : ""}
        <div class="contact-line">${linked} linked job${linked === 1 ? "" : "s"}</div>
      </div>`;
    }).join("") : `<div class="card"><div class="empty">No contacts yet</div></div>`;
  }

  // ---------- settings ----------
  function renderSettings() {
    $("#countryChips").innerHTML = state.settings.countries.map(c => `<span class="chip">${esc(c)}<button data-remove-country="${esc(c)}" aria-label="Remove ${esc(c)}">×</button></span>`).join("") || `<span class="hint">No countries yet</span>`;
  }

  // ---------- modals ----------
  function openModal(id) { $(id).classList.add("open"); $(id).setAttribute("aria-hidden", "false"); }
  function closeModals() { $$(".modal").forEach(m => { m.classList.remove("open"); m.setAttribute("aria-hidden", "true"); }); }

  function openJob(id) {
    const f = $("#jobForm"); f.reset();
    const job = state.jobs.find(j => j.id === id);
    $("#jobModalTitle").textContent = job ? "Edit job" : "Add job";
    $("#deleteJobBtn").style.display = job ? "" : "none";
    const data = job || { status: "Saved", priority: "Medium", workMode: "Hybrid", source: "LinkedIn" };
    for (const el of f.elements) {
      if (!el.name) continue;
      if (el.type === "checkbox") el.checked = !!data[el.name];
      else el.value = data[el.name] ?? "";
    }
    openModal("#jobModal");
    setTimeout(() => f.title.focus(), 30);
  }

  function openContact(id) {
    const f = $("#contactForm"); f.reset();
    const c = state.contacts.find(x => x.id === id);
    $("#contactModalTitle").textContent = c ? "Edit contact" : "Add contact";
    $("#deleteContactBtn").style.display = c ? "" : "none";
    for (const el of f.elements) if (el.name) el.value = c ? (c[el.name] ?? "") : "";
    openModal("#contactModal");
  }

  function formData(form) {
    const o = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      o[el.name] = el.type === "checkbox" ? el.checked : el.type === "number" ? (el.value ? Number(el.value) : null) : el.value.trim();
    }
    if (!o.id) delete o.id;
    return o;
  }

  // ---------- export / import ----------
  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function exportCsv() {
    const keys = ["title", "company", "country", "city", "status", "priority", "workMode", "source", "fitScore", "salary", "appliedDate", "followUpDate", "visa", "language", "contact", "link", "notes"];
    const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [keys.join(","), ...filteredJobs().map(j => keys.map(k => q(j[k])).join(","))].join("\n");
    download(`jobs-${todayStr()}.csv`, csv, "text/csv");
  }

  let toastTimer;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
  }

  // ---------- events ----------
  function bind() {
    window.addEventListener("hashchange", route);
    $("#menuBtn").onclick = () => $("#sidebar").classList.toggle("open");
    $("#themeBtn").onclick = () => {
      const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = t;
      state.settings.theme = t;
      if (Store.user) Store.saveSettings(state.settings);
    };
    $("#addJobBtn").onclick = () => openJob(null);
    $("#addContactBtn").onclick = () => openContact(null);
    $("#globalSearch").addEventListener("input", e => { state.search = e.target.value.trim(); render(); });
    ["#fStatus", "#fCountry", "#fPriority", "#fVisa"].forEach(s => $(s).addEventListener("change", renderJobs));
    $("#pipeCountry").addEventListener("change", renderKanban);
    $("#exportCsvBtn").onclick = exportCsv;

    // row / card clicks
    document.addEventListener("click", e => {
      if (e.target.closest("[data-stop]")) return;
      if (e.target.closest("[data-close]") || e.target.classList.contains("modal")) return closeModals();
      const th = e.target.closest("th[data-sort]");
      if (th) {
        const k = th.dataset.sort;
        state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 };
        return renderJobs();
      }
      const job = e.target.closest("[data-job]");
      if (job && !e.target.closest(".modal")) return openJob(job.dataset.job);
      const c = e.target.closest("[data-contact]");
      if (c) return openContact(c.dataset.contact);
      const rc = e.target.closest("[data-remove-country]");
      if (rc) {
        state.settings.countries = state.settings.countries.filter(x => x !== rc.dataset.removeCountry);
        Store.saveSettings(state.settings).then(render);
      }
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeModals(); });

    $("#jobForm").addEventListener("submit", async e => {
      e.preventDefault();
      const data = formData(e.target);
      if (data.status !== "Saved" && !data.appliedDate) data.appliedDate = todayStr();
      await Store.save("jobs", data);
      state.jobs = await Store.list("jobs");
      closeModals(); toast("Job saved"); render();
    });
    $("#deleteJobBtn").onclick = async () => {
      const id = $("#jobForm").elements.id.value;
      if (!id || !confirm("Delete this job?")) return;
      await Store.remove("jobs", id); state.jobs = await Store.list("jobs");
      closeModals(); toast("Job deleted"); render();
    };
    $("#contactForm").addEventListener("submit", async e => {
      e.preventDefault();
      await Store.save("contacts", formData(e.target));
      state.contacts = await Store.list("contacts");
      closeModals(); toast("Contact saved"); render();
    });
    $("#deleteContactBtn").onclick = async () => {
      const id = $("#contactForm").elements.id.value;
      if (!id || !confirm("Delete this contact?")) return;
      await Store.remove("contacts", id); state.contacts = await Store.list("contacts");
      closeModals(); toast("Contact deleted"); render();
    };

    $("#countryForm").addEventListener("submit", async e => {
      e.preventDefault();
      const v = $("#countryInput").value.trim();
      if (v && !state.settings.countries.includes(v)) {
        state.settings.countries.push(v);
        await Store.saveSettings(state.settings);
      }
      $("#countryInput").value = ""; render();
    });
    bindKanbanDnD();
  }

  // ---------- init ----------
  window.JT = { state, toast, esc, render, refreshJobs: async () => { state.jobs = await Store.list("jobs"); } };

  function showGate(msg, showButton) {
    $("#authGate").classList.remove("hidden");
    $("#authMsg").textContent = msg;
    $("#signInBtn").hidden = !showButton;
  }

  async function start() {
    showGate("Loading your data…", false);
    await load();
    if (window.JobMatch) await window.JobMatch.syncKeys();
    $("#authGate").classList.add("hidden");
    if (Store.user) {
      $("#userBox").hidden = false;
      $("#userName").textContent = Store.user.displayName || Store.user.email || "Signed in";
      if (Store.user.photoURL) $("#userAvatar").src = Store.user.photoURL;
    }
    route();
  }

  function friendlyError(err) {
    const code = (err && err.code) || "";
    if (code.includes("permission-denied")) return "Permission denied. Check the Firestore security rules.";
    if (code.includes("unauthorized-domain")) return "This website is not in Firebase's authorized domains list.";
    if (code.includes("popup-blocked")) return "Your browser blocked the sign-in popup. Allow popups for this site.";
    if (code.includes("popup-closed")) return "Sign-in was cancelled.";
    if (code.includes("unavailable")) return "You're offline. Changes will sync when you reconnect.";
    return (err && err.message) || "Something went wrong";
  }

  (async function init() {
    bind();
    window.addEventListener("unhandledrejection", e => { console.error(e.reason); toast(friendlyError(e.reason)); });

    $("#signInBtn").onclick = async () => {
      try { showGate("Signing in…", false); await Store.signIn(); await start(); }
      catch (err) { showGate(friendlyError(err), true); }
    };
    $("#signOutBtn").onclick = async () => {
      await Store.signOut();
      if (window.JobMatch) window.JobMatch.clearLocalKeys();
      state.jobs = []; state.contacts = [];
      $("#userBox").hidden = true;
      showGate("You're signed out.", true);
    };

    try {
      showGate("Connecting…", false);
      const user = await Store.init();
      if (user) await start();
      else showGate("Sign in to see your job tracker.", true);
    } catch (err) {
      console.error(err);
      showGate("Couldn't connect to Firebase: " + friendlyError(err), false);
    }
  })();
})();
