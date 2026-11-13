/*
 * Apply flow
 * One click on "Apply" opens this panel for a tracker job:
 *  1. Claude tailors your real CV to the job description. It may reorder, select and reword
 *     what is already in your CV, but never adds experience, skills, dates or numbers.
 *  2. Claude writes a cover letter and answers to common application form questions.
 *  3. If information is missing (notice period, salary expectation…), Claude asks you in a box.
 *     Your answers are saved in Firebase (settings.applicantInfo) and reused for every job.
 *  4. Download the CV and cover letter (PDF or Word), open the application page, submit
 *     yourself, then mark the job as Applied.
 * Everything is saved in Firestore under users/{uid}/applications/{jobId}.
 */
window.ApplyFlow = (() => {
  const $ = (s, el = document) => el.querySelector(s);
  const { esc, toast, state } = window.JT;
  const M = window.JobMatch;

  const JSPDF = "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";
  const JSZIP = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";

  let cur = { jobId: null, app: null, busy: false, status: "", tab: "cv", extra: "", jd: "" };

  const job = () => state.jobs.find(j => j.id === cur.jobId);
  const profile = () => state.settings.profile || null;
  const info = () => state.settings.applicantInfo || [];
  const safeUrl = u => /^https:\/\//i.test(u || "") ? u : "";
  const today = () => new Date().toISOString().slice(0, 10);
  const plusDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

  // ---------- Claude ----------
  const CV_ITEM = {
    type: "object",
    properties: {
      title: { type: "string" }, company: { type: "string" }, location: { type: "string" },
      start: { type: "string" }, end: { type: "string" },
      bullets: { type: "array", items: { type: "object", properties: { text: { type: "string" }, relevant: { type: "boolean", description: "True if this bullet directly supports a requirement of the job" } }, required: ["text"] } }
    },
    required: ["title", "company", "bullets"]
  };
  const APP_TOOL = {
    name: "save_application",
    description: "Save the tailored application package for this job.",
    input_schema: {
      type: "object",
      properties: {
        tailoredCv: {
          type: "object",
          properties: {
            headline: { type: "string" },
            summary: { type: "string", description: "3 to 4 sentences, written only from facts in the CV" },
            keyQualifications: { type: "array", items: { type: "string" }, description: "4 to 6 short points that match this job, each backed by the CV" },
            experience: { type: "array", items: CV_ITEM },
            education: { type: "array", items: { type: "object", properties: { degree: { type: "string" }, institution: { type: "string" }, location: { type: "string" }, start: { type: "string" }, end: { type: "string" }, details: { type: "string" } } } },
            certifications: { type: "array", items: { type: "string" } },
            skills: { type: "array", items: { type: "string" }, description: "Skills from the CV, most relevant to this job first" },
            languages: { type: "array", items: { type: "string" } },
            other: { type: "array", items: { type: "object", properties: { heading: { type: "string" }, items: { type: "array", items: { type: "string" } } } } }
          },
          required: ["summary", "experience", "skills"]
        },
        requirements: {
          type: "array",
          description: "The main requirements of the job and how the CV covers them",
          items: { type: "object", properties: { requirement: { type: "string" }, evidence: { type: "string", description: "What in the CV supports it, or empty" }, strength: { type: "string", enum: ["strong", "partial", "missing"] } }, required: ["requirement", "strength"] }
        },
        coverLetter: { type: "string", description: "200 to 300 words, plain text, no placeholders in brackets" },
        formAnswers: {
          type: "array",
          description: "Answers to questions commonly asked in application forms for this job",
          items: { type: "object", properties: { question: { type: "string" }, answer: { type: "string", description: "Empty if the information is unknown" } }, required: ["question", "answer"] }
        },
        questions: {
          type: "array",
          description: "Information you need from the candidate that is NOT in the CV or in their saved answers. At most 6. Empty if nothing is missing.",
          items: { type: "object", properties: { question: { type: "string" }, why: { type: "string" } }, required: ["question"] }
        }
      },
      required: ["tailoredCv", "requirements", "coverLetter", "formAnswers", "questions"]
    }
  };

  async function generate() {
    const j = job(), p = profile();
    const jd = (cur.jd || j.description || "").trim();
    if (!p || !p.cv) throw new Error("Upload your CV again on the AI Job Match page first, so Claude has your full CV.");
    if (jd.length < 80) throw new Error("Paste the job description first.");
    if (jd !== (j.description || "")) { await Store.save("jobs", { ...j, description: jd }); await window.JT.refreshJobs(); }

    setBusy(true, "Claude is tailoring your CV and writing your cover letter… (about 30 to 90 seconds)");
    try {
      const original = { name: p.name, headline: p.headline, ...p.cv };
      const answers = info().filter(x => x.answer);
      const prompt = `You are preparing a job application for the candidate below.

STRICT RULES (most important):
- Use ONLY facts from ORIGINAL CV and CANDIDATE ANSWERS. Never add employers, job titles, dates, degrees, certifications, tools, skills, numbers or achievements that are not there.
- You MAY: reorder roles' bullets so the most relevant come first, reorder skills, reword a bullet to use the job description's terminology when the underlying fact is the same, shorten or drop minor irrelevant bullets, and write the summary and key qualifications from existing facts.
- Keep every role, with its company and dates exactly as in the original. Keep education and certifications exactly as in the original.
- Mark bullets relevant=true when they directly support a requirement in the job description.
- In requirements, list the job's main requirements honestly. If the CV does not cover one, use strength "missing" and do NOT fill the gap.
- Cover letter: specific to ${j.company} and the ${j.title} role, based only on real facts, 200 to 300 words, sign with the candidate's name. No bracketed placeholders.
- formAnswers: include the usual form questions (why this role/company, relevant years of experience, notice period, salary expectation, right to work / visa sponsorship need, willingness to relocate, languages, earliest start date). Answer from the CV and candidate answers only; if unknown leave the answer empty.
- questions: ask the candidate only for information that is needed and missing, and that is not already in CANDIDATE ANSWERS.
${cur.extra ? `- Extra instructions from the candidate: ${cur.extra}\n` : ""}
You must call the save_application tool exactly once; do not reply with plain text.

JOB: ${j.title} at ${j.company} (${[j.city, j.country].filter(Boolean).join(", ")})
JOB DESCRIPTION:
${jd.slice(0, 8000)}

ORIGINAL CV (JSON):
${JSON.stringify(original)}

CANDIDATE ANSWERS (saved earlier):
${answers.length ? answers.map(a => `- ${a.question}: ${a.answer}`).join("\n") : "(none yet)"}`;

      const out = await M.claude({ max_tokens: 16000, tools: [APP_TOOL], messages: [{ role: "user", content: prompt }] });
      const warnings = checkFacts(original, out.tailoredCv || {});
      const app = {
        id: cur.jobId, jobTitle: j.title, company: j.company,
        tailoredCv: out.tailoredCv, requirements: out.requirements || [], coverLetter: out.coverLetter || "",
        formAnswers: out.formAnswers || [], questions: (out.questions || []).filter(q => !answers.some(a => same(a.question, q.question))),
        warnings, model: M.getKeys().model || "claude-sonnet-5-5", createdAt: new Date().toISOString(), appliedAt: cur.app && cur.app.appliedAt || ""
      };
      await Store.save("applications", app);
      cur.app = app;
      toast("Application ready");
    } finally { setBusy(false); }
  }

  const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const same = (a, b) => norm(a) === norm(b);

  // Safety net: flag anything in the tailored CV that is not in the original.
  function checkFacts(orig, t) {
    const w = [];
    const companies = new Set((orig.experience || []).map(e => norm(e.company)));
    (t.experience || []).forEach(e => { if (!companies.has(norm(e.company))) w.push(`Employer "${e.company}" is not in your original CV.`); });
    const origCerts = norm((orig.certifications || []).join(" ") + " " + JSON.stringify(orig.experience || []));
    (t.certifications || []).forEach(c => { if (!origCerts.includes(norm(c).slice(0, 12))) w.push(`Certification "${c}" was not found in your original CV.`); });
    if ((orig.experience || []).length !== (t.experience || []).length) w.push("The number of roles changed. Check that no role was added or removed.");
    return w;
  }

  // ---------- documents ----------
  function cvSections(cv, p) {
    const c = (p.cv && p.cv.contact) || {};
    return {
      name: p.name || "",
      headline: cv.headline || p.headline || "",
      contact: [c.location, c.phone, c.email, c.linkedin, c.website].filter(Boolean).join("  |  "),
      blocks: [
        cv.summary && { h: "Professional Summary", p: [cv.summary] },
        cv.keyQualifications && cv.keyQualifications.length && { h: "Key Qualifications", bullets: cv.keyQualifications },
        cv.experience && cv.experience.length && { h: "Professional Experience", roles: cv.experience },
        cv.certifications && cv.certifications.length && { h: "Certifications", bullets: cv.certifications },
        cv.education && cv.education.length && { h: "Education", edu: cv.education },
        cv.skills && cv.skills.length && { h: "Skills", p: [cv.skills.join(", ")] },
        cv.languages && cv.languages.length && { h: "Languages", p: [cv.languages.join(", ")] },
        ...((cv.other || []).filter(o => o.items && o.items.length).map(o => ({ h: o.heading, bullets: o.items })))
      ].filter(Boolean)
    };
  }
  const dates = r => [r.start, r.end].filter(Boolean).join(" – ");
  const pdfSafe = s => String(s || "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/•/g, "-").replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ]/g, "");

  async function pdfDoc(build) {
    await M.loadScript(JSPDF);
    const doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
    const W = 210, L = 18, R = 18, maxW = W - L - R;
    let y = 18;
    const need = h => { if (y + h > 280) { doc.addPage(); y = 18; } };
    const text = (t, { size = 10, bold = false, indent = 0, gap = 1.2, color = 20 } = {}) => {
      doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(size); doc.setTextColor(color);
      const lines = doc.splitTextToSize(pdfSafe(t), maxW - indent);
      lines.forEach(line => { need(size * 0.45); doc.text(line, L + indent, y); y += size * 0.42; });
      y += gap;
    };
    const bullet = t => {
      doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(20);
      const lines = doc.splitTextToSize(pdfSafe(t), maxW - 5);
      lines.forEach((line, i) => { need(4.5); if (i === 0) doc.text("-", L + 1, y); doc.text(line, L + 5, y); y += 4.2; });
      y += 0.6;
    };
    const heading = h => {
      need(12); y += 2;
      doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(30, 60, 140);
      doc.text(pdfSafe(h).toUpperCase(), L, y); y += 1.6;
      doc.setDrawColor(30, 60, 140); doc.setLineWidth(0.3); doc.line(L, y, W - R, y); y += 4.5;
    };
    const rightText = (t, size = 9.5, at = y) => { if (!t) return; doc.setFont("helvetica", "normal"); doc.setFontSize(size); doc.setTextColor(90); doc.text(pdfSafe(t), W - R, at, { align: "right" }); };
    build({ doc, text, bullet, heading, rightText, nl: (h = 3) => { y += h; }, getY: () => y, setY: v => { y = v; }, need, L, W, R });
    return doc;
  }

  async function cvPdf() {
    const s = cvSections(cur.app.tailoredCv, profile());
    const doc = await pdfDoc(({ text, bullet, heading, rightText, nl, need, getY }) => {
      text(s.name, { size: 18, bold: true, gap: 0.5 });
      if (s.headline) text(s.headline, { size: 11, gap: 0.5, color: 60 });
      if (s.contact) text(s.contact, { size: 9, color: 90, gap: 2 });
      s.blocks.forEach(b => {
        heading(b.h);
        (b.p || []).forEach(t => text(t));
        (b.bullets || []).forEach(bullet);
        (b.roles || []).forEach(r => {
          need(14);
          const y0 = getY();
          text(`${r.title}`, { bold: true, size: 10.5, gap: 0.3 });
          rightText(dates(r), 9.5, y0);
          text([r.company, r.location].filter(Boolean).join(", "), { size: 10, color: 70, gap: 1.2 });
          (r.bullets || []).forEach(x => bullet(x.text || x));
          nl(1.5);
        });
        (b.edu || []).forEach(e => {
          need(10);
          const y1 = getY();
          text(e.degree || "", { bold: true, gap: 0.3 });
          rightText(dates(e), 9.5, y1);
          text([e.institution, e.location].filter(Boolean).join(", ") + (e.details ? ` - ${e.details}` : ""), { color: 70, gap: 2 });
        });
      });
    });
    doc.save(fileName("CV", "pdf"));
  }

  async function letterPdf() {
    const p = profile(); const c = (p.cv && p.cv.contact) || {};
    const doc = await pdfDoc(({ text, nl }) => {
      text(p.name, { size: 16, bold: true, gap: 0.5 });
      text([c.location, c.phone, c.email].filter(Boolean).join("  |  "), { size: 9, color: 90, gap: 6 });
      text(new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }), { gap: 5 });
      cur.app.coverLetter.split(/\n\s*\n/).forEach(par => {
        const lines = par.split("\n");
        lines.forEach((ln, i) => text(ln, { size: 10.5, gap: i === lines.length - 1 ? 3 : 0.4 }));
      });
      nl();
    });
    doc.save(fileName("Cover Letter", "pdf"));
  }

  // Minimal .docx writer (Office Open XML) using JSZip.
  const xml = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const run = (t, { b = false, sz = 21, color = "" } = {}) => `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>${b ? "<w:b/>" : ""}${color ? `<w:color w:val="${color}"/>` : ""}<w:sz w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${xml(t)}</w:t></w:r>`;
  const para = (runs, { after = 80, indent = 0, hanging = 0, border = false, tab = false } = {}) =>
    `<w:p><w:pPr>${border ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="1E3C8C"/></w:pBdr>' : ""}${tab ? '<w:tabs><w:tab w:val="right" w:pos="9900"/></w:tabs>' : ""}<w:spacing w:after="${after}"/>${indent ? `<w:ind w:left="${indent}" w:hanging="${hanging}"/>` : ""}</w:pPr>${runs}</w:p>`;
  async function docx(bodyXml, name) {
    await M.loadScript(JSZIP);
    const zip = new window.JSZip();
    zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`);
    const blob = await zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    download(blob, name);
  }
  async function cvDocx() {
    const s = cvSections(cur.app.tailoredCv, profile());
    const bullet = t => para(run("•\t") + run(t), { indent: 360, hanging: 360, after: 40 });
    let b = para(run(s.name, { b: true, sz: 36 }), { after: 20 });
    if (s.headline) b += para(run(s.headline, { sz: 23, color: "444444" }), { after: 20 });
    if (s.contact) b += para(run(s.contact, { sz: 18, color: "666666" }), { after: 160 });
    s.blocks.forEach(x => {
      b += para(run(x.h.toUpperCase(), { b: true, sz: 22, color: "1E3C8C" }), { after: 100, border: true });
      (x.p || []).forEach(t => { b += para(run(t)); });
      (x.bullets || []).forEach(t => { b += bullet(t); });
      (x.roles || []).forEach(r => {
        b += para(run(r.title, { b: true }) + run("\t" + dates(r), { color: "666666", sz: 19 }), { after: 0, tab: true });
        b += para(run([r.company, r.location].filter(Boolean).join(", "), { color: "555555" }), { after: 60 });
        (r.bullets || []).forEach(t => { b += bullet(t.text || t); });
        b += para("", { after: 60 });
      });
      (x.edu || []).forEach(e => {
        b += para(run(e.degree || "", { b: true }) + run("\t" + dates(e), { color: "666666", sz: 19 }), { after: 0, tab: true });
        b += para(run([e.institution, e.location].filter(Boolean).join(", ") + (e.details ? ` - ${e.details}` : ""), { color: "555555" }), { after: 120 });
      });
    });
    await docx(b, fileName("CV", "docx"));
  }
  async function letterDocx() {
    const p = profile(); const c = (p.cv && p.cv.contact) || {};
    let b = para(run(p.name, { b: true, sz: 32 }), { after: 20 });
    b += para(run([c.location, c.phone, c.email].filter(Boolean).join("  |  "), { sz: 18, color: "666666" }), { after: 300 });
    b += para(run(new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })), { after: 240 });
    cur.app.coverLetter.split(/\n\s*\n/).forEach(par => { b += para(par.split("\n").map((ln, i) => (i ? "<w:r><w:br/></w:r>" : "") + run(ln, { sz: 22 })).join(""), { after: 200 }); });
    await docx(b, fileName("Cover Letter", "docx"));
  }
  function fileName(kind, ext) {
    const clean = s => String(s || "").replace(/[\\/:*?"<>|]+/g, "").trim();
    return `${kind} - ${clean(profile().name)} - ${clean(job().company)}.${ext}`;
  }
  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  // ---------- actions ----------
  async function saveAnswers(form) {
    const list = [...info()];
    form.querySelectorAll("[data-q]").forEach(inp => {
      const q = inp.dataset.q, a = inp.value.trim();
      if (!a) return;
      const i = list.findIndex(x => same(x.question, q));
      if (i >= 0) list[i] = { question: q, answer: a }; else list.push({ question: q, answer: a });
    });
    state.settings.applicantInfo = list;
    await Store.saveSettings(state.settings);
    toast("Answers saved. They will be reused for every application.");
  }
  async function markApplied() {
    const j = job();
    await Store.save("jobs", { ...j, status: "Applied", appliedDate: j.appliedDate || today(), followUpDate: j.followUpDate || plusDays(7) });
    await window.JT.refreshJobs();
    cur.app.appliedAt = new Date().toISOString();
    await Store.save("applications", cur.app);
    toast("Marked as Applied. Follow-up set for 7 days from now.");
    render(); window.JT.render();
  }
  async function saveLetterEdit(text) {
    if (!cur.app || cur.app.coverLetter === text) return;
    cur.app.coverLetter = text;
    await Store.save("applications", cur.app);
  }

  // ---------- UI ----------
  function ensureModal() {
    if ($("#applyModal")) return;
    const m = document.createElement("div");
    m.className = "modal"; m.id = "applyModal"; m.setAttribute("aria-hidden", "true");
    m.innerHTML = `<div class="modal-box wide"><div class="modal-head"><div><h2 id="applyTitle">Application</h2><div class="hint" id="applySub"></div></div><button class="icon-btn" data-close aria-label="Close">✕</button></div><div class="apply-body" id="applyBody"></div></div>`;
    document.body.appendChild(m);
  }
  function setBusy(b, msg) { cur.busy = b; cur.status = b ? msg : ""; render(); }

  async function open(jobId) {
    ensureModal();
    cur = { jobId, app: null, busy: false, status: "", tab: "cv", extra: "", jd: "" };
    const m = $("#applyModal"); m.classList.add("open"); m.setAttribute("aria-hidden", "false");
    render();
    try { cur.app = await Store.getOne("applications", jobId); } catch (e) { console.error(e); }
    render();
    if (!cur.app && profile() && profile().cv && (job().description || "").length >= 80 && M.getKeys().anthropicKey) {
      runSafe(generate)();
    }
  }
  const runSafe = fn => async (...a) => { try { await fn(...a); } catch (e) { console.error(e); cur.busy = false; cur.status = ""; toast(e.message); render(); } };

  function render() {
    const body = $("#applyBody"); if (!body) return;
    const j = job(); if (!j) { body.innerHTML = `<div class="empty">Job not found</div>`; return; }
    const p = profile(); const a = cur.app;
    const applyLink = safeUrl(j.applyUrl) || safeUrl(j.link);
    $("#applyTitle").textContent = `Apply: ${j.title}`;
    $("#applySub").textContent = [j.company, [j.city, j.country].filter(Boolean).join(", "), j.deadline ? `Apply by ${j.deadline}` : "Deadline: N/A", `Applicants: ${j.applicants || "N/A"}`].filter(Boolean).join(" · ");

    const hasKey = !!M.getKeys().anthropicKey;
    const needCv = !p || !p.cv;
    const needJd = (j.description || "").length < 80;

    const steps = `
      <div class="apply-steps">
        <div class="astep ${a ? "done" : "on"}"><span>1</span>Tailor CV and cover letter</div>
        <div class="astep ${a ? "on" : ""}"><span>2</span>Download and open the application</div>
        <div class="astep ${a && a.appliedAt ? "done" : ""}"><span>3</span>Submit and mark as applied</div>
      </div>`;

    const setup = `
      ${!hasKey ? `<div class="notice">Add your Claude API key in <a class="link" href="#settings" data-close>Settings</a> first.</div>` : ""}
      ${needCv ? `<div class="notice">Claude needs your full CV. Go to <a class="link" href="#match" data-close>AI Job Match</a> and upload your CV again (only needed once).</div>` : ""}
      ${needJd || !a ? `
        <label class="field-label">Job description ${needJd ? "<span class='hint'>(paste it here; it's missing for this job)</span>" : ""}</label>
        <textarea class="input" id="jdInput" rows="${needJd ? 8 : 3}" placeholder="Paste the full job description">${esc(cur.jd || j.description || "")}</textarea>` : ""}
      <label class="field-label" style="margin-top:10px">Extra instructions for Claude <span class="hint">(optional, e.g. "emphasise my PCI DSS work")</span></label>
      <input class="input" id="extraInput" value="${esc(cur.extra)}" placeholder="Anything to emphasise?" />
      <div class="btn-row" style="margin-top:12px">
        <button class="btn primary" id="genBtn" ${cur.busy || !hasKey || needCv ? "disabled" : ""}>${a ? "↻ Regenerate" : "✨ Tailor my application"}</button>
      </div>`;

    const status = cur.busy ? `<div class="card status-card"><div class="spinner"></div><span>${esc(cur.status)}</span></div>` : "";

    const questions = a && a.questions && a.questions.length ? `
      <div class="qbox">
        <div class="qbox-head">💬 Claude needs a few details from you</div>
        <form id="qForm">
          ${a.questions.map((q, i) => `<label class="qrow"><span>${esc(q.question)}${q.why ? `<span class="hint"> · ${esc(q.why)}</span>` : ""}</span>
            <input class="input" data-q="${esc(q.question)}" value="${esc((info().find(x => same(x.question, q.question)) || {}).answer || "")}" /></label>`).join("")}
          <div class="btn-row"><button class="btn primary">Save answers and update application</button></div>
        </form>
      </div>` : "";

    const warn = a && a.warnings && a.warnings.length ? `<div class="notice warn">⚠️ Please double-check: ${a.warnings.map(esc).join(" ")}</div>` : "";

    const tabs = a ? `
      <div class="tabs">
        ${[["cv", "Tailored CV"], ["letter", "Cover letter"], ["answers", "Form answers"], ["match", "Match report"]].map(([k, l]) => `<button class="tab ${cur.tab === k ? "on" : ""}" data-tab="${k}">${l}</button>`).join("")}
      </div>
      <div class="tab-body">${tabBody(a)}</div>` : "";

    const actions = a ? `
      <div class="apply-actions">
        <div class="btn-row">
          <button class="btn" data-dl="cv-pdf">⬇ CV (PDF)</button>
          <button class="btn" data-dl="cv-docx">⬇ CV (Word)</button>
          <button class="btn" data-dl="cl-pdf">⬇ Cover letter (PDF)</button>
          <button class="btn" data-dl="cl-docx">⬇ Cover letter (Word)</button>
        </div>
        <div class="btn-row">
          ${applyLink ? `<a class="btn primary" href="${esc(applyLink)}" target="_blank" rel="noopener">Open application page ↗</a>` : `<span class="hint">No application link saved for this job.</span>`}
          ${a.appliedAt ? `<span class="pill"><span class="dot" style="background:var(--s-offer)"></span>Applied ${esc(a.appliedAt.slice(0, 10))}</span>` : `<button class="btn" id="appliedBtn">✓ I've submitted it, mark as Applied</button>`}
        </div>
      </div>` : "";

    body.innerHTML = steps + (a ? "" : setup) + status + questions + warn + actions + tabs + (a ? `<details class="regen"><summary>Change the job description or regenerate</summary>${setup}</details>` : "");
    bind(body);
  }

  function tabBody(a) {
    const cv = a.tailoredCv || {};
    if (cur.tab === "cv") {
      const s = cvSections(cv, profile());
      return `<div class="cv-preview">
        <div class="hint" style="margin-bottom:10px"><span class="hl-sample">Highlighted</span> = experience that matches this job. Highlights are only shown here, not in the downloaded files.</div>
        <div class="cvp-name">${esc(s.name)}</div><div class="cvp-head">${esc(s.headline)}</div><div class="cvp-contact">${esc(s.contact)}</div>
        ${s.blocks.map(b => `<div class="cvp-h">${esc(b.h)}</div>
          ${(b.p || []).map(t => `<p>${esc(t)}</p>`).join("")}
          ${b.bullets ? `<ul>${b.bullets.map(t => `<li class="${b.h === "Key Qualifications" ? "hl" : ""}">${esc(t)}</li>`).join("")}</ul>` : ""}
          ${(b.roles || []).map(r => `<div class="cvp-role"><div class="cvp-role-top"><strong>${esc(r.title)}</strong><span>${esc(dates(r))}</span></div><div class="cvp-co">${esc([r.company, r.location].filter(Boolean).join(", "))}</div>
            <ul>${(r.bullets || []).map(x => `<li class="${x.relevant ? "hl" : ""}">${esc(x.text || x)}</li>`).join("")}</ul></div>`).join("")}
          ${(b.edu || []).map(e => `<div class="cvp-role"><div class="cvp-role-top"><strong>${esc(e.degree)}</strong><span>${esc(dates(e))}</span></div><div class="cvp-co">${esc([e.institution, e.location].filter(Boolean).join(", "))}${e.details ? " · " + esc(e.details) : ""}</div></div>`).join("")}
        `).join("")}
      </div>`;
    }
    if (cur.tab === "letter") {
      return `<div class="hint" style="margin-bottom:8px">You can edit the letter here. Changes are saved automatically and used in the downloads.</div>
        <textarea class="input letter" id="letterInput" rows="16">${esc(a.coverLetter)}</textarea>
        <div class="btn-row" style="margin-top:8px"><button class="btn" data-copy="letter">Copy letter</button></div>`;
    }
    if (cur.tab === "answers") {
      return `<div class="hint" style="margin-bottom:8px">Copy these into the application form. Empty answers mean Claude needs that detail from you (see the questions box).</div>
        <div class="answers">${(a.formAnswers || []).map((f, i) => `<div class="answer"><div class="answer-q">${esc(f.question)}</div>
          <div class="answer-a">${f.answer ? esc(f.answer) : `<span class="hint">Not answered yet</span>`}</div>
          ${f.answer ? `<button class="btn ghost small" data-copy="ans" data-i="${i}">Copy</button>` : ""}</div>`).join("")}</div>`;
    }
    const icon = { strong: "✅", partial: "🟡", missing: "❌" };
    const reqs = a.requirements || [];
    const covered = reqs.filter(r => r.strength !== "missing").length;
    return `<div class="hint" style="margin-bottom:10px">Your CV covers ${covered} of ${reqs.length} main requirements. Claude did not add anything for the ❌ items. They are listed so you can prepare for them.</div>
      <div class="reqs">${reqs.map(r => `<div class="req"><span>${icon[r.strength] || ""}</span><div><div class="req-r">${esc(r.requirement)}</div>${r.evidence ? `<div class="hint">${esc(r.evidence)}</div>` : ""}</div></div>`).join("")}</div>`;
  }

  function bind(body) {
    const jd = $("#jdInput", body); if (jd) jd.oninput = () => { cur.jd = jd.value; };
    const ex = $("#extraInput", body); if (ex) ex.oninput = () => { cur.extra = ex.value; };
    body.querySelectorAll("#genBtn").forEach(b => b.onclick = runSafe(generate));
    body.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { cur.tab = b.dataset.tab; render(); });
    const qf = $("#qForm", body);
    if (qf) qf.onsubmit = runSafe(async e => { e.preventDefault(); await saveAnswers(qf); await generate(); });
    const lt = $("#letterInput", body);
    if (lt) { let t; lt.oninput = () => { clearTimeout(t); t = setTimeout(() => runSafe(saveLetterEdit)(lt.value), 600); }; lt.onblur = () => runSafe(saveLetterEdit)(lt.value); }
    body.querySelectorAll("[data-copy]").forEach(b => b.onclick = async () => {
      const text = b.dataset.copy === "letter" ? cur.app.coverLetter : cur.app.formAnswers[Number(b.dataset.i)].answer;
      try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { toast("Couldn't copy. Select the text and copy it manually."); }
    });
    const dl = { "cv-pdf": cvPdf, "cv-docx": cvDocx, "cl-pdf": letterPdf, "cl-docx": letterDocx };
    body.querySelectorAll("[data-dl]").forEach(b => b.onclick = runSafe(async () => { b.disabled = true; try { await dl[b.dataset.dl](); } finally { b.disabled = false; } }));
    const ap = $("#appliedBtn", body); if (ap) ap.onclick = runSafe(markApplied);
  }

  return { open };
})();
