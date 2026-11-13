/*
 * AI Job Match
 * 1. Upload a CV (PDF, DOCX or TXT). Claude extracts a structured profile and suggests job titles.
 * 2. Search LinkedIn jobs per target country through the Apify actor valig/linkedin-jobs-scraper.
 * 3. Claude scores every job against the profile (1 to 10) with a short reason.
 * 4. Add good matches to the tracker in one click.
 * Without an Apify token, the page still builds ready-made LinkedIn search links (free).
 *
 * Nothing is stored in the browser. API keys, the CV profile, search preferences and the
 * last results are all saved in Firebase and loaded after sign-in (see syncKeys below).
 */
window.JobMatch = (() => {
  const $ = (s, el = document) => el.querySelector(s);
  const { esc, toast, state } = window.JT;

  const EMPTY_KEYS = { anthropicKey: "", apifyToken: "", model: "" };
  const DEFAULT_MODEL = "claude-sonnet-5-5";
  const ACTOR = "valig~linkedin-jobs-scraper";
  const DATE_OPTS = { r86400: "Past 24 hours", r604800: "Past week", r2592000: "Past month" };

  // Everything below lives in memory only and is loaded from Firebase after sign-in.
  let keys = { ...EMPTY_KEYS };
  let results = [];
  const DEFAULT_PREFS = { countries: null, datePosted: "r604800", perCountry: 25, minScore: 0 };
  let prefs = { ...DEFAULT_PREFS };
  let busy = false;
  let status = "";

  const savePrefs = () => { state.settings.matchPrefs = { ...prefs }; Store.saveSettings(state.settings).catch(e => toast(e.message)); };
  const saveResults = () => Store.saveMeta("matchResults", { items: results, savedAt: new Date().toISOString() }).catch(e => toast("Couldn't save results: " + e.message));
  const profile = () => state.settings.profile || null;
  const targetCountries = () => state.settings.countries || [];
  const selectedCountries = () => (prefs.countries || targetCountries()).filter(c => targetCountries().includes(c));
  const safeUrl = u => /^https:\/\//i.test(u || "") ? u : "";

  // ---------- Claude API ----------
  async function claude(body) {
    const key = keys.anthropicKey;
    if (!key) throw new Error("Add your Claude API key in Settings first.");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({ model: keys.model || DEFAULT_MODEL, ...body })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error("Claude API error: " + ((data.error && data.error.message) || res.status));
    const blocks = data.content || [];
    const tool = blocks.find(c => c.type === "tool_use");
    if (tool) return tool.input;
    // Fallback: some models answer with JSON in a text block instead of calling the tool.
    const text = blocks.filter(c => c.type === "text").map(c => c.text).join("\n");
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
    if (m) { try { return JSON.parse(m[1]); } catch {} }
    throw new Error("Claude did not return structured data. Try again.");
  }

  const PROFILE_TOOL = {
    name: "save_profile",
    description: "Save the structured candidate profile extracted from the CV.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        headline: { type: "string", description: "One-line professional headline" },
        yearsExperience: { type: "number", description: "Total years of professional experience" },
        seniority: { type: "string", enum: ["Entry", "Associate", "Mid-Senior", "Manager", "Director"] },
        skills: { type: "array", items: { type: "string" }, description: "Up to 15 most relevant skills" },
        certifications: { type: "array", items: { type: "string" } },
        industries: { type: "array", items: { type: "string" } },
        languages: { type: "array", items: { type: "string" } },
        summary: { type: "string", description: "Two or three sentence summary of the candidate" },
        searchKeywords: { type: "array", items: { type: "string" }, description: "6 to 8 short job titles this candidate should search on LinkedIn, using titles common in European job markets" }
      },
      required: ["name", "headline", "skills", "summary", "searchKeywords"]
    }
  };

  const SCORE_TOOL = {
    name: "save_scores",
    description: "Save a relevance score for every job in the list.",
    input_schema: {
      type: "object",
      properties: {
        scores: {
          type: "array",
          items: {
            type: "object",
            properties: {
              i: { type: "integer", description: "Index of the job in the list" },
              score: { type: "integer", minimum: 1, maximum: 10, description: "10 = excellent fit for this candidate" },
              reason: { type: "string", description: "Why, in at most 20 words" },
              visa: { type: "boolean", description: "True only if the posting mentions visa sponsorship, relocation support or work permit help" },
              language: { type: "string", description: "Required languages other than English, or empty string" }
            },
            required: ["i", "score", "reason"]
          }
        }
      },
      required: ["scores"]
    }
  };

  // ---------- CV reading ----------
  function toBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1]);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("Could not load " + src));
      document.head.appendChild(s);
    });
  }
  async function cvContent(file) {
    const n = file.name.toLowerCase();
    if (file.size > 10 * 1024 * 1024) throw new Error("CV file is larger than 10 MB.");
    if (n.endsWith(".pdf")) {
      return [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: await toBase64(file) } }];
    }
    if (n.endsWith(".docx")) {
      await loadScript("https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js");
      const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      return [{ type: "text", text: "CV:\n" + r.value }];
    }
    if (n.endsWith(".txt") || n.endsWith(".md")) return [{ type: "text", text: "CV:\n" + await file.text() }];
    throw new Error("Please upload a PDF, DOCX or TXT file.");
  }

  async function parseCv(file) {
    setBusy(true, `Reading ${file.name} with Claude…`);
    try {
      const content = await cvContent(file);
      const p = await claude({
        max_tokens: 2000,
        tools: [PROFILE_TOOL],
        messages: [{ role: "user", content: [...content, { type: "text", text: "Read this CV and extract the candidate profile. You must call the save_profile tool exactly once; do not reply with plain text. For searchKeywords, suggest job titles that match the candidate's real experience level and that employers in Europe actually use on LinkedIn." }] }]
      });
      p.fileName = file.name;
      p.parsedAt = new Date().toISOString();
      state.settings.profile = p;
      await Store.saveSettings(state.settings);
      toast("CV analysed");
    } finally { setBusy(false); }
  }

  // ---------- LinkedIn search via Apify ----------
  function booleanQuery(keywords) {
    return keywords.slice(0, 8).map(k => `"${k.replace(/"/g, "")}"`).join(" OR ");
  }
  function linkedinUrl(country) {
    const q = booleanQuery((profile() && profile().searchKeywords) || []);
    return `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(q)}&location=${encodeURIComponent(country)}&f_TPR=${prefs.datePosted}`;
  }

  async function searchCountry(country, keywords) {
    const token = keys.apifyToken;
    const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=240&clean=true&format=json`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keywords: booleanQuery(keywords), location: country, datePosted: prefs.datePosted, limit: Number(prefs.perCountry) })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Apify (${country}): ${res.status} ${t.slice(0, 160)}`);
    }
    const items = await res.json();
    return (Array.isArray(items) ? items : []).map(it => ({
      id: String(it.id || it.url || Math.random()),
      title: it.title || "",
      company: it.companyName || "",
      location: it.location || country,
      country,
      url: it.url || it.applyUrl || "",
      postedTimeAgo: it.postedTimeAgo || "",
      postedDate: it.postedDate || "",
      salary: it.salary || "",
      workType: it.workType || "",
      experienceLevel: it.experienceLevel || "",
      applicationsCount: it.applicationsCount || "",
      description: (it.description || "").replace(/\s+/g, " ").slice(0, 1500)
    }));
  }

  async function scoreJobs(jobs) {
    const p = profile();
    const prof = { headline: p.headline, yearsExperience: p.yearsExperience, seniority: p.seniority, skills: p.skills, certifications: p.certifications, industries: p.industries, languages: p.languages, summary: p.summary };
    const chunks = [];
    for (let i = 0; i < jobs.length; i += 20) chunks.push(jobs.slice(i, i + 20));
    let done = 0;
    const runChunk = async chunk => {
      const list = chunk.map((j, i) => `[${i}] ${j.title} | ${j.company} | ${j.location} | ${j.experienceLevel} | ${j.workType}\n${j.description.slice(0, 900)}`).join("\n\n");
      const out = await claude({
        max_tokens: 3000,
        tools: [SCORE_TOOL],
        messages: [{ role: "user", content: `Candidate profile:\n${JSON.stringify(prof)}\n\nScore how well each job below fits this candidate (skills, seniority, domain). Penalise jobs that require a local language the candidate does not speak, or far more or less seniority. You must call the save_scores tool exactly once and include every index; do not reply with plain text.\n\nJobs:\n${list}` }]
      });
      (out.scores || []).forEach(s => {
        const j = chunk[s.i];
        if (j) Object.assign(j, { score: s.score, reason: s.reason, visa: !!s.visa, language: s.language || "" });
      });
      done += chunk.length;
      setStatus(`Scoring with Claude… ${done}/${jobs.length}`);
    };
    // run up to 3 Claude calls at a time
    for (let i = 0; i < chunks.length; i += 3) await Promise.all(chunks.slice(i, i + 3).map(runChunk));
  }

  async function findJobs() {
    const p = profile();
    if (!p) return toast("Upload your CV first");
    if (!keys.apifyToken) return toast("Add your Apify token in Settings, or use the LinkedIn links");
    if (!keys.anthropicKey) return toast("Add your Claude API key in Settings first");
    const countries = selectedCountries();
    if (!countries.length) return toast("Select at least one country");
    if (!p.searchKeywords || !p.searchKeywords.length) return toast("Add at least one search keyword");

    setBusy(true, `Searching LinkedIn in ${countries.length} countr${countries.length === 1 ? "y" : "ies"}… this can take 1 to 3 minutes`);
    try {
      const settled = await Promise.allSettled(countries.map(c => searchCountry(c, p.searchKeywords)));
      const errors = settled.filter(s => s.status === "rejected").map(s => s.reason.message);
      const seen = new Set();
      const jobs = settled.filter(s => s.status === "fulfilled").flatMap(s => s.value)
        .filter(j => { const k = j.url || j.id; if (seen.has(k)) return false; seen.add(k); return true; });
      if (!jobs.length) {
        results = []; saveResults();
        throw new Error(errors[0] || "No jobs found. Try a longer date range or different keywords.");
      }
      setStatus(`Found ${jobs.length} jobs. Scoring with Claude…`);
      await scoreJobs(jobs);
      results = jobs.map(j => ({ ...j, description: j.description.slice(0, 400) }))
        .sort((a, b) => (b.score || 0) - (a.score || 0));
      saveResults();
      toast(`${results.length} jobs found and scored`);
      if (errors.length) toast(errors[0]);
    } finally { setBusy(false); }
  }

  // ---------- add to tracker ----------
  const inTracker = r => state.jobs.some(j => (j.linkedinId && j.linkedinId === r.id) || (r.url && j.link === r.url));
  async function addToTracker(id) {
    const r = results.find(x => x.id === id);
    if (!r || inTracker(r)) return;
    const mode = /remote/i.test(r.workType) ? "Remote" : /hybrid/i.test(r.workType) ? "Hybrid" : "On-site";
    const city = r.location && r.location !== r.country ? r.location.split(",")[0] : "";
    await Store.save("jobs", {
      title: r.title, company: r.company, country: r.country, city,
      status: "Saved", priority: (r.score || 0) >= 8 ? "High" : (r.score || 0) >= 6 ? "Medium" : "Low",
      workMode: mode, source: "LinkedIn", fitScore: r.score || null, salary: r.salary,
      appliedDate: "", followUpDate: "", link: safeUrl(r.url), contact: "", language: r.language || "",
      visa: !!r.visa, notes: r.reason ? `AI match: ${r.reason}` : "", linkedinId: r.id
    });
    await window.JT.refreshJobs();
    toast("Added to your tracker as Saved");
    render();
  }

  // ---------- UI ----------
  function setBusy(b, msg) { busy = b; status = b ? (msg || "") : ""; render(); }
  function setStatus(msg) { status = msg; const el = $("#matchStatus"); if (el) el.textContent = msg; }

  function chips(list, cls = "tag") { return (list || []).map(x => `<span class="${cls}">${esc(x)}</span>`).join(" "); }

  function render() {
    const view = $("#view-match"); if (!view) return;
    const p = profile();
    const hasA = !!keys.anthropicKey, hasP = !!keys.apifyToken;
    const sel = selectedCountries();
    const shown = results.filter(r => (r.score || 0) >= Number(prefs.minScore || 0));

    view.innerHTML = `
      ${!hasA || !hasP ? `<div class="notice">
        ${!hasA ? "Add your <strong>Claude API key</strong> in Settings to analyse your CV and score jobs. " : ""}
        ${!hasP ? "Add an <strong>Apify token</strong> in Settings to pull LinkedIn jobs into this page. Without it you can still use the LinkedIn search links." : ""}
        <a class="link" href="#settings">Open Settings</a></div>` : ""}

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h3>1. Your CV</h3>${p ? `<span class="hint">${esc(p.fileName || "")}</span>` : ""}</div>
          <label class="dropzone ${busy ? "disabled" : ""}" id="cvDrop">
            <input type="file" id="cvInput" accept=".pdf,.docx,.txt,.md" hidden ${busy ? "disabled" : ""} />
            <div class="dz-icon">⬆</div>
            <div><strong>${p ? "Upload a new CV" : "Upload your CV"}</strong></div>
            <div class="hint">PDF, DOCX or TXT. Claude reads it and builds your profile.</div>
          </label>
          ${p ? `
          <div class="profile">
            <div class="profile-name">${esc(p.name)}</div>
            <div class="profile-headline">${esc(p.headline)}</div>
            <div class="profile-meta">${p.yearsExperience != null ? `${esc(p.yearsExperience)} yrs experience` : ""}${p.seniority ? ` · ${esc(p.seniority)}` : ""}${p.languages && p.languages.length ? ` · ${esc(p.languages.join(", "))}` : ""}</div>
            <p class="profile-summary">${esc(p.summary)}</p>
            ${p.certifications && p.certifications.length ? `<div class="profile-row"><span class="profile-label">Certifications</span>${chips(p.certifications)}</div>` : ""}
            <div class="profile-row"><span class="profile-label">Skills</span>${chips(p.skills)}</div>
          </div>` : ""}
        </div>

        <div class="card">
          <div class="card-head"><h3>2. Search</h3></div>
          ${p ? `
          <div class="field-label">Job titles to search <span class="hint">(click × to remove)</span></div>
          <div class="chips">${(p.searchKeywords || []).map((k, i) => `<span class="chip">${esc(k)}<button data-kw-remove="${i}" aria-label="Remove">×</button></span>`).join("")}</div>
          <form class="inline-form" id="kwForm"><input class="input" id="kwInput" placeholder="Add a job title, e.g. IT Risk Manager" /><button class="btn">Add</button></form>

          <div class="field-label" style="margin-top:14px">Countries <span class="hint">(edit the list in Settings)</span></div>
          <div class="chips">${targetCountries().map(c => `<label class="chip-check ${sel.includes(c) ? "on" : ""}"><input type="checkbox" data-country="${esc(c)}" ${sel.includes(c) ? "checked" : ""} hidden />${esc(c)}</label>`).join("") || `<span class="hint">No target countries yet</span>`}</div>

          <div class="form-grid" style="margin-top:12px">
            <label>Date posted<select class="select" id="mDate">${Object.entries(DATE_OPTS).map(([v, l]) => `<option value="${v}" ${prefs.datePosted === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
            <label>Jobs per country<select class="select" id="mPer">${[10, 25, 50].map(n => `<option ${Number(prefs.perCountry) === n ? "selected" : ""}>${n}</option>`).join("")}</select></label>
          </div>
          <div class="btn-row" style="margin-top:14px">
            <button class="btn primary" id="findBtn" ${busy || !hasP || !hasA ? "disabled" : ""}>✨ Find and score jobs</button>
          </div>
          <div class="hint" style="margin-top:8px">Rough cost per search: about $${(sel.length * prefs.perCountry * 0.0004 + 0.01).toFixed(2)} on Apify plus a few cents of Claude API usage.</div>

          <details class="li-links"><summary>Free option: open these searches on LinkedIn</summary>
            ${sel.map(c => safeUrl(linkedinUrl(c)) ? `<a class="link" href="${esc(linkedinUrl(c))}" target="_blank" rel="noopener">${esc(c)} ↗</a>` : "").join("")}
          </details>
          ` : `<div class="empty">Upload your CV first. Claude will suggest the job titles to search.</div>`}
        </div>
      </div>

      ${busy || status ? `<div class="card status-card"><div class="spinner"></div><span id="matchStatus">${esc(status)}</span></div>` : ""}

      ${results.length ? `
      <div class="card flush">
        <div class="card-head pad">
          <h3>Matches <span class="hint">${shown.length} of ${results.length}</span></h3>
          <label class="hint" style="display:flex;gap:8px;align-items:center">Minimum fit
            <select class="select" id="mMin" style="width:auto">${[0, 5, 6, 7, 8].map(n => `<option value="${n}" ${Number(prefs.minScore) === n ? "selected" : ""}>${n ? n + "+" : "All"}</option>`).join("")}</select>
          </label>
        </div>
        <div class="matches">
          ${shown.map(r => `
          <div class="match">
            <div class="match-score s${Math.round((r.score || 0) / 2)}">${r.score || "–"}</div>
            <div class="match-main">
              <div class="match-title">${esc(r.title)}</div>
              <div class="match-sub">${esc(r.company)} · ${esc(r.location)}${r.postedTimeAgo ? ` · ${esc(r.postedTimeAgo)}` : ""}</div>
              ${r.reason ? `<div class="match-reason">${esc(r.reason)}</div>` : ""}
              <div class="kcard-meta">
                ${r.visa ? `<span class="tag visa-yes">Visa / relocation</span>` : ""}
                ${r.language ? `<span class="tag">Needs ${esc(r.language)}</span>` : ""}
                ${r.workType ? `<span class="tag">${esc(r.workType)}</span>` : ""}
                ${r.experienceLevel ? `<span class="tag">${esc(r.experienceLevel)}</span>` : ""}
                ${r.salary ? `<span class="tag">${esc(r.salary)}</span>` : ""}
                ${r.applicationsCount ? `<span class="tag">${esc(r.applicationsCount)}</span>` : ""}
              </div>
            </div>
            <div class="match-actions">
              ${inTracker(r) ? `<span class="hint">✓ In tracker</span>` : `<button class="btn primary" data-add="${esc(r.id)}">+ Track</button>`}
              ${safeUrl(r.url) ? `<a class="btn" href="${esc(r.url)}" target="_blank" rel="noopener">Open ↗</a>` : ""}
            </div>
          </div>`).join("") || `<div class="empty">No jobs at this fit level</div>`}
        </div>
      </div>` : ""}
    `;
    bind(view);
  }

  function bind(view) {
    const run = fn => async (...a) => { try { await fn(...a); } catch (e) { console.error(e); setBusy(false); toast(e.message); render(); } };
    const input = $("#cvInput", view);
    if (input) input.onchange = run(async e => { const f = e.target.files[0]; if (f) await parseCv(f); });
    const drop = $("#cvDrop", view);
    if (drop) {
      drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
      drop.ondragleave = () => drop.classList.remove("over");
      drop.ondrop = run(async e => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f && !busy) await parseCv(f); });
    }
    const kwForm = $("#kwForm", view);
    if (kwForm) kwForm.onsubmit = run(async e => {
      e.preventDefault();
      const v = $("#kwInput", view).value.trim(); const p = profile();
      if (v && !p.searchKeywords.includes(v)) { p.searchKeywords.push(v); await Store.saveSettings(state.settings); }
      render();
    });
    view.querySelectorAll("[data-kw-remove]").forEach(b => b.onclick = run(async () => {
      profile().searchKeywords.splice(Number(b.dataset.kwRemove), 1);
      await Store.saveSettings(state.settings); render();
    }));
    view.querySelectorAll("[data-country]").forEach(cb => cb.onchange = () => {
      const cur = new Set(selectedCountries());
      cb.checked ? cur.add(cb.dataset.country) : cur.delete(cb.dataset.country);
      prefs.countries = [...cur]; savePrefs(); render();
    });
    const d = $("#mDate", view); if (d) d.onchange = () => { prefs.datePosted = d.value; savePrefs(); render(); };
    const per = $("#mPer", view); if (per) per.onchange = () => { prefs.perCountry = Number(per.value); savePrefs(); render(); };
    const min = $("#mMin", view); if (min) min.onchange = () => { prefs.minScore = Number(min.value); savePrefs(); render(); };
    const find = $("#findBtn", view); if (find) find.onclick = run(findJobs);
    view.querySelectorAll("[data-add]").forEach(b => b.onclick = run(() => addToTracker(b.dataset.add)));
  }

  // ---------- settings: keys ----------
  let fillForm = () => {};
  function initKeysForm() {
    const f = $("#keysForm"); if (!f) return;
    fillForm = () => {
      f.anthropicKey.value = keys.anthropicKey || "";
      f.apifyToken.value = keys.apifyToken || "";
      f.model.value = keys.model || DEFAULT_MODEL;
    };
    fillForm();
    f.onsubmit = async e => {
      e.preventDefault();
      const next = { anthropicKey: f.anthropicKey.value.trim(), apifyToken: f.apifyToken.value.trim(), model: f.model.value };
      try { await Store.saveKeys(next); keys = next; toast("Keys saved to your account"); }
      catch (err) { console.error(err); toast("Couldn't save keys to Firebase: " + err.message); }
    };
    $("#clearKeysBtn").onclick = async () => {
      try { await Store.saveKeys({ ...EMPTY_KEYS }); keys = { ...EMPTY_KEYS }; fillForm(); toast("Keys removed"); }
      catch (err) { console.error(err); toast("Couldn't remove keys: " + err.message); }
    };
  }

  // Called after sign-in: load keys, preferences and the last results from Firebase.
  async function syncKeys() {
    if (!Store.user) return;
    prefs = { ...DEFAULT_PREFS, ...(state.settings.matchPrefs || {}) };
    try {
      const [k, saved] = await Promise.all([Store.getKeys(), Store.getMeta("matchResults")]);
      keys = { ...EMPTY_KEYS, ...k };
      results = (saved && Array.isArray(saved.items)) ? saved.items : [];
    } catch (err) { console.error("Loading AI Job Match data failed", err); toast("Couldn't load your keys: " + err.message); }
    fillForm();
  }
  // On sign-out, drop everything held in memory.
  function clearLocalKeys() { keys = { ...EMPTY_KEYS }; results = []; prefs = { ...DEFAULT_PREFS }; fillForm(); }

  initKeysForm();

  return { render, syncKeys, clearLocalKeys };
})();
