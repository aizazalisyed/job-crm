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
  const LINKEDIN_ACTOR = "valig~linkedin-jobs-scraper";      // cheap, LinkedIn only
  const BOARDS_ACTOR = "openclawai~job-board-scraper";       // Indeed, Glassdoor, Bayt
  const SOURCES = {
    linkedin: { label: "LinkedIn", costPerJob: 0.0004 },
    indeed: { label: "Indeed", costPerJob: 0.006 },
    glassdoor: { label: "Glassdoor", costPerJob: 0.006 },
    bayt: { label: "Bayt (Gulf)", costPerJob: 0.006 }
  };
  const HOURS = { r86400: 24, r604800: 168, r2592000: 720 };
  const DATE_OPTS = { r86400: "Past 24 hours", r604800: "Past week", r2592000: "Past month" };

  // Everything below lives in memory only and is loaded from Firebase after sign-in.
  let keys = { ...EMPTY_KEYS };
  let results = [];
  const DEFAULT_PREFS = { countries: null, datePosted: "r604800", perCountry: 25, minScore: 0, sources: ["linkedin", "indeed", "glassdoor"], workMode: "any", showMode: "any",
    sortBy: "fit", fCountry: "", fSource: "", visaOnly: false, hideTracked: false, q: "" };
  const SORTS = {
    fit: "Best fit",
    applicantsAsc: "Fewest applicants",
    applicantsDesc: "Most applicants",
    newest: "Newest first",
    deadline: "Deadline soonest",
    company: "Company A to Z",
    country: "Country A to Z"
  };
  const WORLD = "Worldwide";
  const TOP_N = 100;               // keep only the 100 most relevant jobs
  const WORLD_LIMIT = 200;         // LinkedIn jobs fetched for a worldwide search before ranking
  const MODES = { any: "Any", remote: "Remote only", hybrid: "Hybrid", onsite: "On-site" };
  const MODE_LABEL = { remote: "Remote", hybrid: "Hybrid", onsite: "On-site" };
  let prefs = { ...DEFAULT_PREFS };
  let busy = false;
  let status = "";

  const savePrefs = () => { state.settings.matchPrefs = { ...prefs }; Store.saveSettings(state.settings).catch(e => toast(e.message)); };
  // Each result is its own Firestore doc in users/{uid}/matches (keeps the full job description for applications).
  const saveResults = () => Store.replaceAll("matches", results).catch(e => toast("Couldn't save results: " + e.message));
  const safeId = (src, raw) => (src + "-" + String(raw || Math.random()).replace(/[^A-Za-z0-9_-]/g, "_")).slice(0, 140);
  const cleanText = t => String(t || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  async function pool(tasks, limit) {
    const out = []; let i = 0;
    const worker = async () => { while (i < tasks.length) { const k = i++; try { out[k] = { ok: true, value: await tasks[k]() }; } catch (e) { out[k] = { ok: false, error: e }; } } };
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    return out;
  }
  const profile = () => state.settings.profile || null;
  const targetCountries = () => state.settings.countries || [];
  const selectedCountries = () => (prefs.countries || targetCountries()).filter(c => c === WORLD || targetCountries().includes(c));
  const countryFromLocation = loc => { const parts = String(loc || "").split(",").map(x => x.trim()).filter(Boolean); return parts[parts.length - 1] || WORLD; };
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
        searchKeywords: { type: "array", items: { type: "string" }, description: "6 to 8 short job titles this candidate should search on LinkedIn, using titles common in European job markets" },
        cv: {
          type: "object",
          description: "The COMPLETE CV content, copied faithfully (word for word where possible). Do not summarise, drop or invent anything.",
          properties: {
            contact: { type: "object", properties: { email: { type: "string" }, phone: { type: "string" }, location: { type: "string" }, linkedin: { type: "string" }, website: { type: "string" } } },
            summary: { type: "string" },
            experience: { type: "array", items: { type: "object", properties: { title: { type: "string" }, company: { type: "string" }, location: { type: "string" }, start: { type: "string" }, end: { type: "string" }, bullets: { type: "array", items: { type: "string" } } }, required: ["title", "company", "bullets"] } },
            education: { type: "array", items: { type: "object", properties: { degree: { type: "string" }, institution: { type: "string" }, location: { type: "string" }, start: { type: "string" }, end: { type: "string" }, details: { type: "string" } } } },
            certifications: { type: "array", items: { type: "string" } },
            skills: { type: "array", items: { type: "string" } },
            languages: { type: "array", items: { type: "string" } },
            other: { type: "array", description: "Any other sections (projects, awards, publications…)", items: { type: "object", properties: { heading: { type: "string" }, items: { type: "array", items: { type: "string" } } } } }
          },
          required: ["experience"]
        }
      },
      required: ["name", "headline", "skills", "summary", "searchKeywords", "cv"]
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
              language: { type: "string", description: "Required languages other than English, or empty string" },
              deadline: { type: "string", description: "Application deadline as YYYY-MM-DD if the posting clearly states one, otherwise empty string. Never guess." },
              workMode: { type: "string", enum: ["Remote", "Hybrid", "On-site", "Unknown"], description: "Work arrangement stated in the posting. Remote = fully remote. Unknown if not stated." }
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
        max_tokens: 12000,
        tools: [PROFILE_TOOL],
        messages: [{ role: "user", content: [...content, { type: "text", text: "Read this CV and extract the candidate profile. You must call the save_profile tool exactly once; do not reply with plain text. Copy the full CV into the cv field faithfully, keeping every role and every bullet. For searchKeywords, suggest job titles that match the candidate's real experience level and that employers in Europe actually use on LinkedIn." }] }]
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

  async function apifyRun(actor, input) {
    const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(keys.apifyToken)}&timeout=290&clean=true&format=json`;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`${res.status} ${t.slice(0, 160)}`);
    }
    const items = await res.json();
    return Array.isArray(items) ? items : [];
  }

  async function searchLinkedIn(country, keywords) {
    const base = country === WORLD ? WORLD_LIMIT : Number(prefs.perCountry);
    const limit = prefs.workMode && prefs.workMode !== "any" ? Math.min(base * 2, 300) : base;   // fetch extra, Claude filters by work mode
    const items = await apifyRun(LINKEDIN_ACTOR, { keywords: booleanQuery(keywords), location: country, datePosted: prefs.datePosted, limit })
      .catch(e => { throw new Error(`LinkedIn (${country}): ${e.message}`); });
    return items.map(it => ({
      id: safeId("li", it.id || it.url),
      source: "LinkedIn",
      title: it.title || "",
      company: it.companyName || "",
      location: it.location || country,
      country: country === WORLD ? countryFromLocation(it.location) : country,
      url: it.url || "",
      applyUrl: it.applyUrl || it.url || "",
      postedTimeAgo: it.postedTimeAgo || "",
      postedDate: it.postedDate || "",
      salary: it.salary || "",
      industry: it.workType || it.sector || "",   // this actor's "workType" field holds the industry
      workMode: "",                              // set by Claude from the description
      experienceLevel: it.experienceLevel || "",
      applicants: it.applicationsCount || "",
      description: cleanText(it.description).slice(0, 6000)
    }));
  }

  async function searchBoards(country, keywords, sites) {
    const per = Math.max(5, Math.round(Number(prefs.perCountry) / 2));
    const items = await apifyRun(BOARDS_ACTOR, {
      searchTerms: keywords.slice(0, 2), location: country, sites, maxResults: per,
      hoursOld: HOURS[prefs.datePosted], countryIndeed: country, descriptionFormat: "markdown",
      ...(prefs.workMode === "remote" ? { isRemote: true } : {}),
      proxyConfiguration: { useApifyProxy: true }
    }).catch(e => { throw new Error(`${sites.map(x => SOURCES[x].label).join("/")} (${country}): ${e.message}`); });
    return items.filter(it => it.title && (it.job_url || it.job_url_direct)).map(it => {
      const site = String(it.site || "").toLowerCase();
      const sal = it.salary_min || it.salary_max ? [it.salary_min, it.salary_max].filter(Boolean).join(" to ") + (it.salary_currency ? " " + it.salary_currency : "") + (it.salary_interval ? " / " + it.salary_interval : "") : "";
      return {
        id: safeId(site || "board", it.id || it.job_url),
        source: (SOURCES[site] && SOURCES[site].label.replace(" (Gulf)", "")) || it.site || "Job board",
        title: it.title, company: it.company || "", location: it.location || country, country,
        url: it.job_url || it.job_url_direct, applyUrl: it.job_url_direct || it.job_url,
        postedTimeAgo: "", postedDate: it.date_posted || "", salary: sal,
        industry: it.company_industry || "", workMode: it.is_remote ? "Remote" : "", experienceLevel: "", applicants: "",
        description: cleanText(it.description).slice(0, 6000)
      };
    });
  }

  async function scoreJobs(jobs) {
    const p = profile();
    const prof = { headline: p.headline, yearsExperience: p.yearsExperience, seniority: p.seniority, skills: p.skills, certifications: p.certifications, industries: p.industries, languages: p.languages, summary: p.summary };
    const chunks = [];
    for (let i = 0; i < jobs.length; i += 20) chunks.push(jobs.slice(i, i + 20));
    let done = 0;
    const runChunk = async chunk => {
      const desc = d => d.length > 1300 ? d.slice(0, 1000) + "\n…\n" + d.slice(-300) : d;
      const list = chunk.map((j, i) => `[${i}] ${j.title} | ${j.company} | ${j.location} | ${j.experienceLevel} | ${j.industry || ""}\n${desc(j.description)}`).join("\n\n");
      const out = await claude({
        max_tokens: 3000,
        tools: [SCORE_TOOL],
        messages: [{ role: "user", content: `Candidate profile:\n${JSON.stringify(prof)}\n\nScore how well each job below fits this candidate (skills, seniority, domain). Today is ${new Date().toISOString().slice(0, 10)}. Also classify each job's work mode (Remote, Hybrid, On-site or Unknown) from the posting text and location. Penalise jobs that require a local language the candidate does not speak, or far more or less seniority. You must call the save_scores tool exactly once and include every index; do not reply with plain text.\n\nJobs:\n${list}` }]
      });
      (out.scores || []).forEach(s => {
        const j = chunk[s.i];
        if (j) Object.assign(j, { score: s.score, reason: s.reason, visa: !!s.visa, language: s.language || "", deadline: /^\d{4}-\d{2}-\d{2}$/.test(s.deadline || "") ? s.deadline : "", workMode: j.workMode || (s.workMode && s.workMode !== "Unknown" ? s.workMode : "") });
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

    const sources = (prefs.sources || []).filter(x => SOURCES[x]);
    if (!sources.length) return toast("Select at least one job site");
    const boardSites = sources.filter(x => x !== "linkedin");
    const tasks = [];
    if (countries.includes(WORLD) && !sources.includes("linkedin")) return toast("Worldwide search uses LinkedIn. Turn on LinkedIn in Job sites.");
    countries.forEach(c => {
      if (sources.includes("linkedin")) tasks.push(() => searchLinkedIn(c, p.searchKeywords));
      if (boardSites.length && c !== WORLD) tasks.push(() => searchBoards(c, p.searchKeywords, boardSites));
    });
    const names = sources.map(x => SOURCES[x].label).join(", ");
    const where = countries.includes(WORLD) ? `worldwide${countries.length > 1 ? ` and ${countries.length - 1} more` : ""}` : `${countries.length} countr${countries.length === 1 ? "y" : "ies"}`;
    setBusy(true, `Searching ${names} ${countries.includes(WORLD) ? "" : "in "}${where}${prefs.workMode !== "any" ? ` (${MODES[prefs.workMode].toLowerCase()})` : ""}… this can take 2 to 5 minutes`);
    try {
      const settled = await pool(tasks, 4);
      const errors = settled.filter(s => !s.ok).map(s => s.error.message);
      const seen = new Set();
      const norm = t => (t || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const jobs = settled.filter(s => s.ok).flatMap(s => s.value)
        .filter(j => { const k = norm(j.title) + "|" + norm(j.company) + "|" + j.country; if (seen.has(k)) return false; seen.add(k); return true; });
      if (!jobs.length) {
        results = []; saveResults();
        throw new Error(errors[0] || "No jobs found. Try a longer date range or different keywords.");
      }
      setStatus(`Found ${jobs.length} jobs. Scoring with Claude…`);
      await scoreJobs(jobs);
      const want = MODE_LABEL[prefs.workMode];
      const filtered = want ? jobs.filter(j => j.workMode === want) : jobs;
      results = filtered.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, TOP_N);
      saveResults();
      toast(want
        ? `${filtered.length} of ${jobs.length} jobs are ${want.toLowerCase()}. Showing the top ${results.length}.`
        : `${jobs.length} jobs scored. Showing the top ${results.length}.`);
      if (errors.length) toast(`${errors.length} search(es) failed: ${errors[0]}`);
    } finally { setBusy(false); }
  }

  // ---------- add to tracker ----------
  const inTracker = r => state.jobs.some(j => (j.linkedinId && j.linkedinId === r.id) || (r.url && j.link === r.url));
  function trackerJobFromResult(r) {
    const mode = ["Remote", "Hybrid", "On-site"].includes(r.workMode) ? r.workMode : "";
    const city = r.location && r.location !== r.country ? r.location.split(",")[0] : "";
    return {
      title: r.title, company: r.company, country: r.country, city,
      status: "Saved", priority: (r.score || 0) >= 8 ? "High" : (r.score || 0) >= 6 ? "Medium" : "Low",
      workMode: mode, source: r.source === "LinkedIn" ? "LinkedIn" : "Job board", board: r.source || "",
      fitScore: r.score || null, salary: r.salary || "",
      appliedDate: "", followUpDate: "", link: safeUrl(r.url), applyUrl: safeUrl(r.applyUrl || r.url),
      deadline: r.deadline || "", applicants: r.applicants || r.applicationsCount || "",
      contact: "", language: r.language || "", visa: !!r.visa,
      notes: r.reason ? `AI match: ${r.reason}` : "", description: r.description || "", linkedinId: r.id
    };
  }
  // Returns the tracker job for a result, creating it if needed.
  async function ensureTracked(r) {
    const existing = state.jobs.find(j => (j.linkedinId && j.linkedinId === r.id) || (r.url && j.link === r.url));
    if (existing) return existing;
    const saved = await Store.save("jobs", trackerJobFromResult(r));
    await window.JT.refreshJobs();
    return state.jobs.find(j => j.id === saved.id) || saved;
  }
  async function addToTracker(id) {
    const r = results.find(x => x.id === id);
    if (!r || inTracker(r)) return;
    await ensureTracked(r);
    toast("Added to your tracker as Saved");
    render();
  }
  async function applyTo(id) {
    const r = results.find(x => x.id === id);
    if (!r) return;
    const job = await ensureTracked(r);
    render();
    window.ApplyFlow.open(job.id);
  }

  // ---------- UI ----------
  function setBusy(b, msg) { busy = b; status = b ? (msg || "") : ""; render(); }
  function setStatus(msg) { status = msg; const el = $("#matchStatus"); if (el) el.textContent = msg; }

  function estimateCost(nCountries) {
    const src = prefs.sources || [];
    const per = Number(prefs.perCountry);
    const li = src.includes("linkedin") ? per * SOURCES.linkedin.costPerJob : 0;
    const boards = src.filter(x => x !== "linkedin").length * Math.max(5, Math.round(per / 2)) * 2 * 0.006;
    const sel = selectedCountries();
    const world = sel.includes(WORLD);
    const nC = sel.filter(c => c !== WORLD).length;
    const mult = prefs.workMode && prefs.workMode !== "any" ? 2 : 1;
    return nC * (li * mult + boards) + (world && src.includes("linkedin") ? Math.min(WORLD_LIMIT * mult, 300) * SOURCES.linkedin.costPerJob : 0) + 0.01;
  }
  const deadlineTag = d => {
    if (!d) return "";
    const n = Math.round((new Date(d + "T00:00:00") - new Date(new Date().toISOString().slice(0, 10) + "T00:00:00")) / 86400000);
    return `<span class="tag ${n < 0 ? "tag-bad" : n <= 7 ? "tag-warn" : ""}">${n < 0 ? "Deadline passed" : "Apply by " + esc(d)}</span>`;
  };

  // "Over 200 applicants" -> 201, "Be among the first 25 applicants" -> 24, "37 applicants" -> 37, unknown -> null
  function applicantCount(r) {
    const t = String(r.applicants || r.applicationsCount || "");
    const m = t.replace(/,/g, "").match(/\d+/);
    if (!m) return null;
    const n = Number(m[0]);
    return /over|more than|\+/i.test(t) ? n + 1 : /first|fewer|less than|under/i.test(t) ? n - 1 : n;
  }
  // hours since posted, from a date or "4 days ago"
  function ageHours(r) {
    const d = Date.parse(r.postedDate || "");
    if (!isNaN(d)) return (Date.now() - d) / 3600000;
    const m = String(r.postedTimeAgo || "").match(/(\d+)\s*(minute|hour|day|week|month)/i);
    if (!m) return null;
    return Number(m[1]) * { minute: 1 / 60, hour: 1, day: 24, week: 168, month: 720 }[m[2].toLowerCase()];
  }
  function filterAndSort(list) {
    const showMode = MODE_LABEL[prefs.showMode];
    const q = (prefs.q || "").toLowerCase().trim();
    const out = list.filter(r =>
      (r.score || 0) >= Number(prefs.minScore || 0) &&
      (!showMode || r.workMode === showMode) &&
      (!prefs.fCountry || r.country === prefs.fCountry) &&
      (!prefs.fSource || (r.source || "LinkedIn") === prefs.fSource) &&
      (!prefs.visaOnly || r.visa) &&
      (!prefs.hideTracked || !inTracker(r)) &&
      (!q || [r.title, r.company, r.location, r.reason, r.industry].some(v => (v || "").toLowerCase().includes(q))));
    // unknown values (N/A) always go to the bottom
    const by = (get, dir = 1) => (a, b) => {
      const x = get(a), y = get(b);
      if (x == null && y == null) return (b.score || 0) - (a.score || 0);
      if (x == null) return 1; if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir || (b.score || 0) - (a.score || 0);
    };
    const cmp = {
      fit: (a, b) => (b.score || 0) - (a.score || 0),
      applicantsAsc: by(applicantCount, 1),
      applicantsDesc: by(applicantCount, -1),
      newest: by(ageHours, 1),
      deadline: by(r => r.deadline || null, 1),
      company: by(r => (r.company || "").toLowerCase() || null, 1),
      country: by(r => (r.country || "").toLowerCase() || null, 1)
    }[prefs.sortBy] || ((a, b) => (b.score || 0) - (a.score || 0));
    return out.sort(cmp);
  }
  const activeFilters = () => [prefs.showMode !== "any", Number(prefs.minScore) > 0, prefs.fCountry, prefs.fSource, prefs.visaOnly, prefs.hideTracked, prefs.q].filter(Boolean).length;

  function chips(list, cls = "tag") { return (list || []).map(x => `<span class="${cls}">${esc(x)}</span>`).join(" "); }

  function render() {
    const view = $("#view-match"); if (!view) return;
    const p = profile();
    const hasA = !!keys.anthropicKey, hasP = !!keys.apifyToken;
    const sel = selectedCountries();
    const shown = filterAndSort(results);
    const resCountries = [...new Set(results.map(r => r.country).filter(Boolean))].sort();
    const resSources = [...new Set(results.map(r => r.source || "LinkedIn"))].sort();

    view.innerHTML = `
      ${!hasA || !hasP ? `<div class="notice">
        ${!hasA ? "Add your <strong>Claude API key</strong> in Settings to analyse your CV and score jobs. " : ""}
        ${!hasP ? "Add an <strong>Apify token</strong> in Settings to pull jobs from LinkedIn, Indeed and Glassdoor into this page. Without it you can still use the LinkedIn search links." : ""}
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
          <div class="chips"><label class="chip-check world ${sel.includes(WORLD) ? "on" : ""}" title="Search every country and keep the top ${TOP_N} matches"><input type="checkbox" data-country="${WORLD}" ${sel.includes(WORLD) ? "checked" : ""} hidden />🌍 Worldwide</label>${targetCountries().filter(c => c !== WORLD).map(c => `<label class="chip-check ${sel.includes(c) ? "on" : ""}"><input type="checkbox" data-country="${esc(c)}" ${sel.includes(c) ? "checked" : ""} hidden />${esc(c)}</label>`).join("") || `<span class="hint">No target countries yet</span>`}</div>

          <div class="field-label" style="margin-top:14px">Job sites</div>
          <div class="chips">${Object.entries(SOURCES).map(([k, v]) => `<label class="chip-check ${(prefs.sources || []).includes(k) ? "on" : ""}"><input type="checkbox" data-source="${k}" ${(prefs.sources || []).includes(k) ? "checked" : ""} hidden />${v.label}</label>`).join("")}</div>

          <div class="form-grid" style="margin-top:12px">
            <label>Date posted<select class="select" id="mDate">${Object.entries(DATE_OPTS).map(([v, l]) => `<option value="${v}" ${prefs.datePosted === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
            <label>Work mode<select class="select" id="mMode">${Object.entries(MODES).map(([v, l]) => `<option value="${v}" ${prefs.workMode === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
            <label>Jobs per country<select class="select" id="mPer">${[10, 25, 50].map(n => `<option ${Number(prefs.perCountry) === n ? "selected" : ""}>${n}</option>`).join("")}</select></label>
          </div>
          <div class="btn-row" style="margin-top:14px">
            <button class="btn primary" id="findBtn" ${busy || !hasP || !hasA ? "disabled" : ""}>✨ Find and score jobs</button>
          </div>
          <div class="hint" style="margin-top:8px">Rough cost per search: about $${estimateCost(sel.length).toFixed(2)} on Apify plus a few cents of Claude API usage.</div>

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
          ${activeFilters() ? `<button class="btn ghost small" id="mReset">Reset filters</button>` : ""}
        </div>
        <div class="filter-bar">
          <label>Sort by<select class="select" id="mSort">${Object.entries(SORTS).map(([v, l]) => `<option value="${v}" ${prefs.sortBy === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          <label>Country<select class="select" id="mCountry"><option value="">All (${resCountries.length})</option>${resCountries.map(c => `<option ${prefs.fCountry === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
          <label>Site<select class="select" id="mSource"><option value="">All</option>${resSources.map(c => `<option ${prefs.fSource === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
          <label>Work mode<select class="select" id="mShow">${Object.entries(MODES).map(([v, l]) => `<option value="${v}" ${prefs.showMode === v ? "selected" : ""}>${v === "any" ? "All" : l}</option>`).join("")}</select></label>
          <label>Minimum fit<select class="select" id="mMin">${[0, 5, 6, 7, 8, 9].map(n => `<option value="${n}" ${Number(prefs.minScore) === n ? "selected" : ""}>${n ? n + "+" : "All"}</option>`).join("")}</select></label>
          <label class="grow">Search results<input class="input" id="mQ" value="${esc(prefs.q || "")}" placeholder="Title, company, city…" /></label>
          <label class="check"><input type="checkbox" id="mVisa" ${prefs.visaOnly ? "checked" : ""} /> Visa / relocation only</label>
          <label class="check"><input type="checkbox" id="mHide" ${prefs.hideTracked ? "checked" : ""} /> Hide jobs already in tracker</label>
        </div>
        <div class="matches">
          ${shown.map(r => `
          <div class="match">
            <div class="match-score s${Math.round((r.score || 0) / 2)}">${r.score || "–"}</div>
            <div class="match-main">
              <div class="match-title">${esc(r.title)}</div>
              <div class="match-sub">${esc(r.company)} · ${esc(r.location)}${r.postedTimeAgo ? ` · ${esc(r.postedTimeAgo)}` : r.postedDate ? ` · posted ${esc(r.postedDate)}` : ""} · <span class="src">${esc(r.source || "LinkedIn")}</span></div>
              ${r.reason ? `<div class="match-reason">${esc(r.reason)}</div>` : ""}
              <div class="kcard-meta">
                ${r.visa ? `<span class="tag visa-yes">Visa / relocation</span>` : ""}
                ${r.language ? `<span class="tag">Needs ${esc(r.language)}</span>` : ""}
                <span class="tag ${r.workMode === "Remote" ? "visa-yes" : ""}">${r.workMode ? (r.workMode === "Remote" ? "🏠 Remote" : r.workMode === "Hybrid" ? "🏢 Hybrid" : "📍 On-site") : "Work mode: N/A"}</span>
                ${r.industry ? `<span class="tag">${esc(r.industry)}</span>` : ""}
                ${r.experienceLevel ? `<span class="tag">${esc(r.experienceLevel)}</span>` : ""}
                ${r.salary ? `<span class="tag">${esc(r.salary)}</span>` : ""}
                <span class="tag">Applicants: ${esc(r.applicants || r.applicationsCount || "N/A")}</span>
                ${r.deadline ? deadlineTag(r.deadline) : `<span class="tag">Deadline: N/A</span>`}
              </div>
            </div>
            <div class="match-actions">
              <button class="btn primary" data-apply="${esc(r.id)}">✨ Apply</button>
              ${inTracker(r) ? `<span class="hint" style="text-align:center">✓ In tracker</span>` : `<button class="btn" data-add="${esc(r.id)}">+ Track</button>`}
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
    const md = $("#mMode", view); if (md) md.onchange = () => { prefs.workMode = md.value; savePrefs(); render(); };
    const sh = $("#mShow", view); if (sh) sh.onchange = () => { prefs.showMode = sh.value; savePrefs(); render(); };
    const bindSel = (id, key) => { const el = $(id, view); if (el) el.onchange = () => { prefs[key] = el.type === "checkbox" ? el.checked : el.value; savePrefs(); render(); }; };
    bindSel("#mSort", "sortBy"); bindSel("#mCountry", "fCountry"); bindSel("#mSource", "fSource"); bindSel("#mVisa", "visaOnly"); bindSel("#mHide", "hideTracked");
    const mq = $("#mQ", view);
    if (mq) { let t; mq.oninput = () => { clearTimeout(t); t = setTimeout(() => { prefs.q = mq.value; savePrefs(); render(); const el = $("#mQ"); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 350); }; }
    const rs = $("#mReset", view); if (rs) rs.onclick = () => { Object.assign(prefs, { showMode: "any", minScore: 0, fCountry: "", fSource: "", visaOnly: false, hideTracked: false, q: "" }); savePrefs(); render(); };
    const per = $("#mPer", view); if (per) per.onchange = () => { prefs.perCountry = Number(per.value); savePrefs(); render(); };
    const min = $("#mMin", view); if (min) min.onchange = () => { prefs.minScore = Number(min.value); savePrefs(); render(); };
    const find = $("#findBtn", view); if (find) find.onclick = run(findJobs);
    view.querySelectorAll("[data-add]").forEach(b => b.onclick = run(() => addToTracker(b.dataset.add)));
    view.querySelectorAll("[data-apply]").forEach(b => b.onclick = run(() => applyTo(b.dataset.apply)));
    view.querySelectorAll("[data-source]").forEach(cb => cb.onchange = () => {
      const cur = new Set(prefs.sources || []);
      cb.checked ? cur.add(cb.dataset.source) : cur.delete(cb.dataset.source);
      prefs.sources = Object.keys(SOURCES).filter(k => cur.has(k)); savePrefs(); render();
    });
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
      const [k, saved] = await Promise.all([Store.getKeys(), Store.list("matches")]);
      keys = { ...EMPTY_KEYS, ...k };
      results = saved.sort((a, b) => (b.score || 0) - (a.score || 0));
    } catch (err) { console.error("Loading AI Job Match data failed", err); toast("Couldn't load your keys: " + err.message); }
    fillForm();
  }
  // On sign-out, drop everything held in memory.
  function clearLocalKeys() { keys = { ...EMPTY_KEYS }; results = []; prefs = { ...DEFAULT_PREFS }; fillForm(); }

  initKeysForm();

  return { render, syncKeys, clearLocalKeys, claude, loadScript, getKeys: () => keys };
})();
