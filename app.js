/* MedsAlarm web — traducción de la app Android (Kotlin/Compose) a una PWA.
   Equivalencias: MedicationStore/HistoryStore -> localStorage, AlarmScheduler -> reloj interno,
   AlarmActivity/AlarmService -> pantalla de alarma + sonido + notificación, HistoryExport -> pdf.js + Web Share. */
(() => {
  "use strict";

  const SNOOZE_MINUTES = 10;
  const CATCH_UP_MINUTES = 60;      // si abres la app hasta 60 min tarde, la alarma igual suena
  const MAX_HISTORY = 5000;
  const K = { meds: "medsalarm.medications", hist: "medsalarm.history", lang: "medsalarm.language",
              state: "medsalarm.alarmState", awake: "medsalarm.keepAwake" };

  /* ---------------- Utilidades ---------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (id) => `<svg aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const pad = (n) => String(n).padStart(2, "0");
  const timeLabel = (h, m) => `${pad(h)}:${pad(m)}`;
  const epochDay = (d = new Date()) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
  const dayToDate = (ed) => { const u = new Date(ed * 864e5); return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate()); };
  const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

  function load(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw); }
    catch { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* almacenamiento lleno o bloqueado */ }
  }

  /* ---------------- Idioma ---------------- */
  let lang = load(K.lang, null) || "es";   // igual que la app Android: español por defecto
  function t(key, ...args) {
    let s = (I18N[lang] && I18N[lang][key]) ?? I18N.es[key] ?? key;
    args.forEach((a, i) => { s = s.replace(new RegExp(`%${i + 1}\\$[sd]`, "g"), a); });
    return s;
  }
  const locale = () => ({ es: "es", en: "en", pt: "pt-BR" }[lang]);
  const fmtDate = (d) => new Intl.DateTimeFormat(locale(), { dateStyle: "medium" }).format(d);
  const fmtDayTitle = (d) => new Intl.DateTimeFormat(locale(), { weekday: "long", day: "numeric", month: "long" }).format(d);

  /* ---------------- Datos (equivale a MedicationStore + HistoryStore) ---------------- */
  let meds = load(K.meds, []);
  let history = load(K.hist, []);
  // Estado de alarmas: qué día ya sonó cada una y aplazamientos pendientes
  let alarmState = load(K.state, { fired: {}, snoozes: {} });

  const sortMeds = (list) => list.slice().sort((a, b) => a.hour - b.hour || a.minute - b.minute || a.name.localeCompare(b.name));
  const takenToday = (m) => m.lastTakenEpochDay === epochDay();
  const findMed = (id) => meds.find(m => m.id === id);

  function saveMeds() { save(K.meds, meds); }
  function saveState() { save(K.state, alarmState); }

  function upsertMed({ id, name, dose, notes, hour, minute }) {
    const base = (id && findMed(id)) || { id: Date.now(), enabled: true, lastTakenEpochDay: null };
    const med = { ...base, name: name.trim(), dose: dose.trim(), notes: notes.trim(), hour, minute };
    // Si se cambia la hora a un momento futuro, la alarma de hoy puede volver a sonar
    if (alarmState.fired[med.id] === epochDay()) {
      const now = new Date();
      if (hour * 60 + minute > now.getHours() * 60 + now.getMinutes()) delete alarmState.fired[med.id];
    }
    meds = sortMeds(meds.filter(m => m.id !== med.id).concat(med));
    saveMeds(); saveState();
    return med;
  }
  function deleteMed(id) {
    meds = meds.filter(m => m.id !== id);
    delete alarmState.fired[id]; delete alarmState.snoozes[id];
    saveMeds(); saveState();
    stopRinging(id);
  }
  function setEnabled(id, enabled) {
    meds = meds.map(m => m.id === id ? { ...m, enabled } : m);
    if (!enabled) { delete alarmState.snoozes[id]; saveState(); stopRinging(id); }
    saveMeds();
  }
  /** Marca la toma de hoy y la registra en el historial (una sola vez por día). */
  function markTaken(id) {
    const med = findMed(id);
    if (!med) return;
    const wasTaken = takenToday(med);
    meds = meds.map(m => m.id === id ? { ...m, lastTakenEpochDay: epochDay() } : m);
    saveMeds();
    if (!wasTaken) {
      const now = Date.now();
      history = [{ id: now, medId: med.id, name: med.name, dose: med.dose || "", notes: med.notes || "", takenAtMillis: now }]
        .concat(history).sort((a, b) => b.takenAtMillis - a.takenAtMillis).slice(0, MAX_HISTORY);
      save(K.hist, history);
    }
    delete alarmState.snoozes[id]; saveState();
    stopRinging(id);
  }

  /* ---------------- Sonido y vibración (equivale a AlarmService) ---------------- */
  let audioCtx = null, beepTimer = null, testing = false;
  function ensureAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch { /* sin audio */ }
    return audioCtx;
  }
  // Cualquier toque desbloquea el audio (los navegadores lo exigen)
  ["pointerdown", "keydown", "touchstart"].forEach(ev =>
    window.addEventListener(ev, () => { ensureAudio(); updateSoundHint(); }, { passive: true }));

  function beepPattern() {
    const ctx = audioCtx;
    if (!ctx || ctx.state !== "running") return;
    const t0 = ctx.currentTime;
    // Dos tonos ascendentes, tres veces: suena a despertador sin ser estridente
    [0, 0.32, 0.64].forEach((offset, i) => {
      [880, 1175].forEach((freq, j) => {
        const start = t0 + offset + j * 0.14;
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = "triangle"; osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.5, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start); osc.stop(start + 0.14);
      });
    });
  }
  function startSound() {
    ensureAudio();
    if (beepTimer) return;
    beepPattern();
    beepTimer = setInterval(() => { beepPattern(); updateSoundHint(); }, 1600);
    try { navigator.vibrate?.([700, 400, 700, 400, 700]); } catch {}
    vibrateTimer = setInterval(() => { try { navigator.vibrate?.([700, 400, 700, 400, 700]); } catch {} }, 3300);
  }
  let vibrateTimer = null;
  function stopSound() {
    clearInterval(beepTimer); beepTimer = null;
    clearInterval(vibrateTimer); vibrateTimer = null;
    try { navigator.vibrate?.(0); } catch {}
  }

  /* ---------------- Notificaciones ---------------- */
  let swReg = null;
  const notifSupported = () => "Notification" in window && "serviceWorker" in navigator;
  async function showAlarmNotification(med) {
    if (!notifSupported() || Notification.permission !== "granted") return;
    const label = med.dose ? `${med.name} · ${med.dose}` : med.name;
    const options = {
      body: t("notif_text", label) + (med.notes ? `\n${med.notes}` : ""),
      tag: `med-${med.id}`, renotify: true, requireInteraction: true,
      icon: "icons/icon-192.png", badge: "icons/icon-192.png",
      vibrate: [700, 400, 700, 400, 700],
      data: { medId: med.id },
      actions: [
        { action: "taken", title: t("mark_taken") },
        { action: "snooze", title: t("snooze_minutes", SNOOZE_MINUTES) }
      ]
    };
    try {
      const reg = swReg || await navigator.serviceWorker.ready;
      await reg.showNotification(t("notif_title"), options);
    } catch {
      try { new Notification(t("notif_title"), { body: options.body, tag: options.tag, icon: options.icon }); } catch {}
    }
  }
  async function closeNotification(id) {
    try {
      const reg = swReg || await navigator.serviceWorker.getRegistration();
      const list = await reg?.getNotifications({ tag: `med-${id}` });
      list?.forEach(n => n.close());
    } catch {}
  }

  /* ---------------- Alarmas (equivale a AlarmScheduler + AlarmActivity) ---------------- */
  let ringing = [];   // ids sonando, en orden de llegada

  function trigger(id) {
    const med = findMed(id);
    if (!med || ringing.includes(id)) return;
    ringing.push(id);
    showAlarmNotification(med);
    renderAlarm();
    startSound();
    requestWakeLock(true);
  }
  function stopRinging(id) {
    ringing = ringing.filter(x => x !== id);
    closeNotification(id);
    renderAlarm();
    if (!ringing.length) { stopSound(); requestWakeLock(false); }
    render();
  }
  function snooze(id) {
    alarmState.snoozes[id] = Date.now() + SNOOZE_MINUTES * 60_000;
    saveState();
    stopRinging(id);
    toast(t("snoozed", SNOOZE_MINUTES));
  }

  function tick() {
    const now = new Date(), today = epochDay(now), nowMs = now.getTime();
    for (const med of meds) {
      if (!med.enabled || takenToday(med)) continue;
      const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), med.hour, med.minute).getTime();
      const late = nowMs - due;
      if (late >= 0 && late < CATCH_UP_MINUTES * 60_000 && alarmState.fired[med.id] !== today) {
        alarmState.fired[med.id] = today; saveState();
        trigger(med.id);
      }
    }
    for (const [idStr, at] of Object.entries(alarmState.snoozes)) {
      if (nowMs >= at) {
        const id = Number(idStr);
        delete alarmState.snoozes[idStr]; saveState();
        const med = findMed(id);
        if (med && med.enabled && !takenToday(med)) trigger(id);
      }
    }
    // Cambio de día: refrescar la pantalla para reiniciar "tomados hoy"
    if (tick.lastDay !== today) { tick.lastDay = today; render(); }
  }

  function renderAlarm() {
    const box = $("#alarm");
    if (!ringing.length) { box.hidden = true; document.body.style.overflow = ""; return; }
    const med = findMed(ringing[0]);
    if (!med) { ringing.shift(); return renderAlarm(); }
    $("#alarm-kicker").textContent = t("its_time");
    $("#alarm-name").textContent = med.name || t("default_med_name_alarm");
    $("#alarm-dose").textContent = med.dose || ""; $("#alarm-dose").hidden = !med.dose;
    $("#alarm-notes").textContent = med.notes || ""; $("#alarm-notes").hidden = !med.notes;
    $("#alarm-msg").textContent = t("alarm_message");
    $("#alarm-taken").textContent = t("mark_taken");
    $("#alarm-snooze").textContent = t("snooze_minutes", SNOOZE_MINUTES);
    $("#alarm-dismiss").textContent = t("silence_for_now");
    const more = ringing.length - 1;
    $("#alarm-queue").hidden = more <= 0;
    $("#alarm-queue").textContent = more > 0 ? `+${more}` : "";
    box.hidden = false;
    document.body.style.overflow = "hidden";
    updateSoundHint();
    if (!box.contains(document.activeElement)) $("#alarm-taken").focus();
  }
  function updateSoundHint() {
    const hint = $("#alarm-sound-hint");
    if (!hint) return;
    const blocked = ringing.length && (!audioCtx || audioCtx.state !== "running");
    hint.hidden = !blocked;
    hint.textContent = t("tap_for_sound");
  }
  $("#alarm-taken").addEventListener("click", () => { const id = ringing[0]; markTaken(id); toast(t("marked_taken")); });
  $("#alarm-snooze").addEventListener("click", () => snooze(ringing[0]));
  $("#alarm-dismiss").addEventListener("click", () => stopRinging(ringing[0]));
  $("#alarm").addEventListener("click", () => { ensureAudio(); updateSoundHint(); });

  /* ---------------- Pantalla encendida ---------------- */
  let wakeLock = null, keepAwake = load(K.awake, false);
  async function requestWakeLock(forAlarm) {
    const want = keepAwake || (forAlarm && ringing.length);
    try {
      if (want && !wakeLock && "wakeLock" in navigator && document.visibilityState === "visible") {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      } else if (!want && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch { wakeLock = null; }
  }

  /* ---------------- Instalación ---------------- */
  let installPrompt = null;
  const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; render(); });
  window.addEventListener("appinstalled", () => { installPrompt = null; render(); });
  async function doInstall() {
    if (!installPrompt) return;
    installPrompt.prompt();
    try { await installPrompt.userChoice; } catch {}
    installPrompt = null; render();
  }

  async function enableAlerts() {
    ensureAudio();
    if (notifSupported() && Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch {}
    }
    alertsDismissed = true;
    render(); if (openSheet === "settings") renderSettings();
  }
  let alertsDismissed = false;
  const needsAlerts = () => notifSupported() && Notification.permission === "default" && !alertsDismissed;

  /* ---------------- Vistas ---------------- */
  let view = "home";
  let confirmDeleteId = null;
  let period = { kind: "7", from: null, to: null };
  const app = $("#app");

  function greeting() {
    // Mismos cortes que la app Android: 5–11 mañana, 12–18 tarde, resto noche
    const h = new Date().getHours();
    return h >= 5 && h <= 11 ? t("greeting_morning") : h >= 12 && h <= 18 ? t("greeting_afternoon") : t("greeting_evening");
  }

  function render() {
    document.documentElement.lang = lang;
    if (view === "history") return renderHistory();
    renderHome();
  }

  function renderHome() {
    const taken = meds.filter(takenToday).length;
    const banners = [];
    if (needsAlerts()) banners.push(`
      <div class="glass-card banner">
        <span class="icon-tile">${icon("bell")}</span>
        <div class="banner-text"><strong>${t("enable_alerts_title")}</strong><span>${t("enable_alerts_desc")}</span></div>
        <button class="btn btn-gold" data-act="enable-alerts">${t("enable")}</button>
      </div>`);
    if (!isStandalone() && installPrompt) banners.push(`
      <div class="glass-card banner">
        <span class="icon-tile">${icon("install")}</span>
        <div class="banner-text"><strong>${t("install_app")}</strong><span>${t("install_desc")}</span></div>
        <button class="btn btn-gold" data-act="install">${t("install_app")}</button>
      </div>`);

    app.innerHTML = `
      <div class="screen">
        <header class="head">
          <div class="head-titles">
            <p class="greeting">${greeting()}</p>
            <h1 class="title">${t("your_medication")}</h1>
          </div>
          <button class="icon-btn" data-act="history" aria-label="${esc(t("history_cd"))}" title="${esc(t("history_cd"))}">${icon("history")}</button>
          <button class="icon-btn" data-act="lang" aria-label="${esc(t("change_language"))}" title="${esc(t("change_language"))}">${icon("globe")}</button>
          <button class="icon-btn" data-act="settings" aria-label="${esc(t("settings"))}" title="${esc(t("settings"))}">${icon("gear")}</button>
        </header>
        <div class="glass-card summary-card">
          <span class="icon-tile big">${icon("bell")}</span>
          <div>
            <p class="summary-day">${t("today")}</p>
            <p class="summary-count num">${meds.length ? t("taken_of_total", taken, meds.length) : t("no_reminders_yet")}</p>
          </div>
        </div>
        ${banners.join("")}
        ${meds.length ? `<div class="med-list">${meds.map(medCard).join("")}</div>` : `
          <div class="white-card empty">
            <span class="empty-icon">${icon("pill")}</span>
            <h2>${t("add_first_med")}</h2>
            <p>${t("add_first_med_desc")}</p>
            <button class="btn btn-teal" data-act="add">${t("new_medication")}</button>
          </div>`}
      </div>
      <button class="fab" data-act="add" aria-label="${esc(t("add_medication_cd"))}" title="${esc(t("add_medication_cd"))}">${icon("plus")}</button>
    `;
  }

  function medCard(m) {
    const done = takenToday(m);
    return `
      <article class="white-card med" data-id="${m.id}">
        <div class="med-row">
          <button class="med-open" data-act="edit" aria-label="${esc(t("edit_medication"))}: ${esc(m.name)}">
            <span class="med-tile ${done ? "is-taken" : ""}">${icon(done ? "check-circle" : "pill")}</span>
            <span class="med-info">
              <span class="med-name">${esc(m.name)}</span>
              ${m.dose ? `<span class="med-dose">${esc(m.dose)}</span>` : ""}
              <span class="med-when">${icon("schedule")}<span class="num">${t("daily_at", timeLabel(m.hour, m.minute))}</span></span>
              ${m.notes ? `<span class="med-notes">${esc(m.notes)}</span>` : ""}
            </span>
          </button>
          <button class="icon-btn del" data-act="delete" aria-label="${esc(t("delete_cd"))}" title="${esc(t("delete_cd"))}">${icon("trash")}</button>
        </div>
        ${confirmDeleteId === m.id ? `
          <div class="confirm-row">
            <p>${esc(t("confirm_delete", m.name))}</p>
            <button class="btn btn-plain" data-act="cancel-delete">${t("cancel")}</button>
            <button class="btn btn-coral" data-act="confirm-delete">${t("delete_cd")}</button>
          </div>` : ""}
        ${done
          ? `<div class="btn btn-block btn-taken-done">${icon("check-circle")}${t("taken_today")}</div>`
          : `<button class="btn btn-block btn-green" data-act="taken">${t("mark_taken")}</button>`}
      </article>`;
  }

  /* ---------- Historial (equivale a HistoryScreen) ---------- */
  // range = null significa "Todo" (como en Android)
  function periodRange() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (period.kind === "7") return [new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6), today];
    if (period.kind === "30") return [new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29), today];
    if (period.kind === "custom" && period.from && period.to) {
      let from = parseIso(period.from), to = parseIso(period.to);
      if (from > to) [from, to] = [to, from];
      return [from, to];
    }
    return null;
  }
  function logsInRange() {
    const r = periodRange();
    const list = history.slice().sort((a, b) => b.takenAtMillis - a.takenAtMillis);
    if (!r) return list;
    const start = r[0].getTime(), end = new Date(r[1].getFullYear(), r[1].getMonth(), r[1].getDate() + 1).getTime();
    return list.filter(h => h.takenAtMillis >= start && h.takenAtMillis < end);
  }
  function exportRange(logs) {
    const r = periodRange();
    if (r) return r;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (!logs.length) return [today, today];
    const oldest = new Date(Math.min(...logs.map(l => l.takenAtMillis))); oldest.setHours(0, 0, 0, 0);
    return [oldest, today];
  }

  function renderHistory() {
    const r = periodRange();
    const logs = logsInRange();
    const canExport = logs.length > 0;
    const chip = (k, label) => `<button class="chip" data-period="${k}" aria-pressed="${period.kind === k}">${label}</button>`;
    app.innerHTML = `
      <div class="screen history">
        <header class="head">
          <button class="icon-btn" data-act="back" aria-label="${esc(t("back_cd"))}" title="${esc(t("back_cd"))}">${icon("back")}</button>
          <h1 class="title title-sm">${t("history")}</h1>
        </header>
        <div class="chips">
          ${chip("7", t("period_7"))}${chip("30", t("period_30"))}${chip("all", t("period_all"))}${chip("custom", t("period_custom"))}
        </div>
        ${r ? `<p class="period-line">${t("period_label", fmtDate(r[0]), fmtDate(r[1]))}</p>` : ""}
        ${logs.length ? `<div class="log-list">${logs.map(l => {
            const d = new Date(l.takenAtMillis);
            return `<div class="white-card log">
              <span class="log-name">${esc(l.name)}</span>
              ${l.dose ? `<span class="log-dose">${esc(l.dose)}</span>` : ""}
              <span class="log-when num">${fmtDate(d)}&nbsp;&nbsp;${timeLabel(d.getHours(), d.getMinutes())}</span>
              ${l.notes ? `<span class="log-notes">${esc(l.notes)}</span>` : ""}
            </div>`;
          }).join("")}</div>`
          : `<div class="white-card no-history">${t("no_history")}</div>`}
      </div>
      <div class="export-dock">
        <div class="export-inner">
          <button class="btn btn-block btn-green tall" data-act="pdf" ${canExport ? "" : "disabled"}>${icon("download")}${t("download_pdf")}</button>
          <div class="share-row">
            <button class="btn btn-white" data-act="whatsapp" ${canExport ? "" : "disabled"}>${icon("chat")}${t("share_whatsapp")}</button>
            <button class="btn btn-white" data-act="email" ${canExport ? "" : "disabled"}>${icon("mail")}${t("share_email")}</button>
          </div>
        </div>
      </div>`;
  }

  // Selector de período (equivale al DateRangePicker de Android)
  function openRangePicker() {
    const today = isoDate(new Date());
    const r = periodRange() || [new Date(Date.now() - 6 * 864e5), new Date()];
    showSheet("range", `${sheetHead(t("pick_range"))}
      <form id="range-form" novalidate style="display:grid;gap:16px">
        <div class="range">
          <div class="field"><label for="range-from">${t("from")}</label><input type="date" id="range-from" value="${isoDate(r[0])}" max="${today}" required></div>
          <div class="field"><label for="range-to">${t("to")}</label><input type="date" id="range-to" value="${isoDate(r[1])}" max="${today}"></div>
        </div>
        <div class="sheet-actions">
          <button type="button" class="btn btn-plain" data-act="close-sheet-btn">${t("cancel")}</button>
          <button type="submit" class="btn btn-teal">${t("ok")}</button>
        </div>
      </form>`);
    $("#range-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const from = $("#range-from").value, to = $("#range-to").value || from;
      if (!from) return;
      period = { kind: "custom", from, to };
      closeSheet(); render();
    });
  }

  /* ---------- PDF y compartir (equivale a HistoryExport) ---------- */
  function makePdfFile() {
    const logs = logsInRange();
    const [from, to] = exportRange(logs);
    const bytes = MedsPdf.build({
      title: t("pdf_title"),
      period: t("pdf_period", fmtDate(from), fmtDate(to)),
      generated: t("pdf_generated", fmtDate(new Date())),
      total: t("pdf_total", logs.length),
      headers: [t("pdf_col_datetime"), t("pdf_col_med"), t("pdf_col_dose")],
      rows: logs.map(l => {
        const d = new Date(l.takenAtMillis);
        return { when: `${fmtDate(d)} ${timeLabel(d.getHours(), d.getMinutes())}`, name: l.name, dose: l.dose, notes: l.notes };
      }),
      notesPrefix: (n) => t("pdf_notes_prefix", n),
      pageLabel: (n) => t("pdf_page", n),
      emptyText: t("pdf_empty")
    });
    const name = `historial_medicacion_${isoDate(from)}_${isoDate(to)}.pdf`;
    return { file: new File([bytes], name, { type: "application/pdf" }), from, to };
  }
  function downloadFile(file) {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url; a.download = file.name; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  async function exportPdf(target) {
    let pdf;
    try { pdf = makePdfFile(); } catch (e) { console.error(e); return toast(t("pdf_error")); }
    const { file, from, to } = pdf;
    if (target === "download") { downloadFile(file); return toast(t("pdf_saved")); }

    const text = t("share_text", fmtDate(from), fmtDate(to));
    const subject = t("share_subject");
    // En celulares (y Windows/Mac recientes) se abre el menú de compartir del sistema con el PDF adjunto
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: subject, text });
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
      }
    }
    // Plan B: descargar el PDF y abrir WhatsApp Web o el correo con el texto listo
    downloadFile(file);
    if (target === "whatsapp") window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
    else location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
    toast(t("attach_hint"), 6000);
  }

  /* ---------- Hojas: editor, idioma, ajustes ---------- */
  let openSheet = null;
  const sheetRoot = $("#sheet-root");
  let lastFocus = null;

  function showSheet(kind, html) {
    lastFocus = document.activeElement;
    openSheet = kind;
    sheetRoot.innerHTML = `<div class="scrim" data-act="close-sheet"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="sheet-grip"></div>${html}</div></div>`;
  }
  function closeSheet() {
    openSheet = null; sheetRoot.innerHTML = "";
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }
  const sheetHead = (title) => `<div class="sheet-head"><h2 id="sheet-title">${title}</h2>
    <button class="icon-btn" data-act="close-sheet-btn" aria-label="${esc(t("cancel"))}">${icon("close")}</button></div>`;

  function openEditor(id) {
    const m = id ? findMed(id) : null;
    const now = new Date();
    const h = m ? m.hour : 8, mi = m ? m.minute : 0;
    showSheet("editor", `
      ${sheetHead(m ? t("edit_medication") : t("new_medication"))}
      <form id="med-form" novalidate>
        <div style="display:grid;gap:14px">
          <div class="field">
            <label for="f-name">${t("med_name_label")}</label>
            <input id="f-name" name="name" maxlength="80" autocomplete="off" placeholder="${esc(t("med_name_hint"))}" value="${esc(m?.name || "")}">
            <span class="error" id="f-name-err" hidden>${t("name_required")}</span>
          </div>
          <div class="field">
            <label for="f-dose">${t("dose_label")}</label>
            <input id="f-dose" name="dose" maxlength="80" autocomplete="off" placeholder="${esc(t("dose_hint"))}" value="${esc(m?.dose || "")}">
          </div>
          <div class="field">
            <label for="f-notes">${t("notes_label")}</label>
            <textarea id="f-notes" name="notes" maxlength="300" placeholder="${esc(t("notes_hint"))}">${esc(m?.notes || "")}</textarea>
          </div>
          <div class="field">
            <label for="f-time">${t("daily_reminder_time")}</label>
            <input id="f-time" name="time" type="time" required value="${timeLabel(h, mi)}">
          </div>
          <div class="sheet-actions">
            <button type="button" class="btn btn-plain" data-act="close-sheet-btn">${t("cancel")}</button>
            <button type="submit" class="btn btn-teal" id="f-save" ${m ? "" : "disabled"}>${t("save_alarm")}</button>
          </div>
        </div>
      </form>`);
    const form = $("#med-form");
    $("#f-name").focus();
    $("#f-name").addEventListener("input", (e) => { $("#f-save").disabled = !e.target.value.trim(); $("#f-name-err").hidden = true; });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = $("#f-name").value.trim();
      if (!name) { $("#f-name-err").hidden = false; $("#f-name").focus(); return; }
      const [hh, mm] = ($("#f-time").value || "08:00").split(":").map(Number);
      upsertMed({ id: m?.id, name, dose: $("#f-dose").value, notes: $("#f-notes").value, hour: hh, minute: mm });
      ensureAudio();
      closeSheet(); render(); toast(t("saved"));
    });
  }

  function openLanguage() {
    const opt = (code, label) => `<button class="lang-option" data-lang="${code}" role="radio" aria-checked="${lang === code}"><span class="radio"></span>${label}</button>`;
    showSheet("lang", `${sheetHead(t("language"))}
      <div class="lang-list" role="radiogroup">${opt("es", "Español")}${opt("en", "English")}${opt("pt", "Português")}</div>
      <div class="sheet-actions"><button class="btn btn-plain" data-act="close-sheet-btn">${t("cancel")}</button></div>`);
  }

  function notifStatusText() {
    if (!notifSupported()) return t("notif_unsupported");
    return { granted: t("notif_on"), denied: t("notif_blocked"), default: t("notif_off") }[Notification.permission];
  }
  function openSettings() { showSheet("settings", ""); renderSettings(); }
  function renderSettings() {
    const sheet = $(".sheet", sheetRoot);
    if (!sheet) return;
    const canAskNotif = notifSupported() && Notification.permission === "default";
    let installBlock;
    if (isStandalone()) installBlock = `<p>${t("installed")}</p>`;
    else if (installPrompt) installBlock = `<p>${t("install_desc")}</p><div><button class="btn btn-teal" data-act="install">${icon("install")}${t("install_app")}</button></div>`;
    else if (isIOS()) installBlock = `<p>${t("install_ios")}</p>`;
    else installBlock = `<p>${t("install_desc")}</p>`;
    sheet.innerHTML = `<div class="sheet-grip"></div>${sheetHead(t("settings"))}
      <div class="set-group" style="border:0;padding-top:0">
        <h3>${t("alerts")}</h3>
        <div class="set-row">
          <span>${t("notifications")}: <span class="status">${notifStatusText()}</span></span>
          ${canAskNotif ? `<button class="btn btn-teal" data-act="enable-alerts">${t("enable")}</button>` : ""}
        </div>
        <div class="set-row">
          <button class="btn btn-plain" data-act="sound-test">${icon("bell")}${testing ? t("stop") : t("sound_test")}</button>
        </div>
        <label class="switch" for="keep-awake" style="color:#1B1C1C;font-size:15px;justify-content:space-between;width:100%">
          <span>${t("keep_awake")}</span>
          <input type="checkbox" id="keep-awake" ${keepAwake ? "checked" : ""}><span class="track"></span>
        </label>
        <p>${t("keep_awake_desc")}</p>
      </div>
      <div class="set-group">
        <h3>${t("how_title")}</h3>
        <p>${t("how_text")}</p>
      </div>
      <div class="set-group">
        <h3>${t("install_app")}</h3>
        ${installBlock}
      </div>
      <div class="set-group">
        <h3>${t("backup")}</h3>
        <p>${t("backup_desc")}</p>
        <div class="set-row" style="justify-content:flex-start">
          <button class="btn btn-plain" data-act="export-data">${icon("download")}${t("export_data")}</button>
          <label class="btn btn-plain" for="import-file">${t("import_data")}</label>
          <input type="file" id="import-file" accept="application/json,.json" hidden>
        </div>
      </div>`;
    $("#keep-awake").addEventListener("change", (e) => {
      keepAwake = e.target.checked; save(K.awake, keepAwake); requestWakeLock(false);
    });
    $("#import-file").addEventListener("change", importData);
  }

  function exportData() {
    const data = { app: "MedsAlarm", version: 1, exportedAt: new Date().toISOString(), medications: meds, history };
    downloadFile(new File([JSON.stringify(data, null, 2)], `medsalarm_copia_${isoDate(new Date())}.json`, { type: "application/json" }));
  }
  async function importData(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== "MedsAlarm" || !Array.isArray(data.medications) || !Array.isArray(data.history)) throw new Error("bad");
      const okMed = (m) => m && typeof m.id === "number" && typeof m.name === "string" && Number.isInteger(m.hour) && Number.isInteger(m.minute);
      const okLog = (l) => l && typeof l.takenAtMillis === "number" && typeof l.name === "string";
      if (!data.medications.every(okMed) || !data.history.every(okLog)) throw new Error("bad");
      meds = sortMeds(data.medications.map(m => ({ enabled: true, lastTakenEpochDay: null, dose: "", notes: "", ...m })));
      // Combina el historial sin duplicar
      const seen = new Set(history.map(h => h.id));
      history = history.concat(data.history.filter(h => !seen.has(h.id)))
        .sort((a, b) => b.takenAtMillis - a.takenAtMillis).slice(0, MAX_HISTORY);
      saveMeds(); save(K.hist, history);
      closeSheet(); render(); toast(t("import_ok"));
    } catch {
      toast(t("import_error"));
    }
    e.target.value = "";
  }

  /* ---------- Aviso breve ---------- */
  let toastTimer = null;
  function toast(msg, ms = 2600) {
    const el = $("#toast");
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  /* ---------- Eventos ---------- */
  document.addEventListener("click", (e) => {
    const target = e.target.closest("[data-act],[data-period],[data-lang]");
    if (!target) return;
    if (target.dataset.lang) {
      lang = target.dataset.lang; save(K.lang, lang);
      closeSheet(); render(); renderAlarm(); return;
    }
    if (target.dataset.period) {
      if (target.dataset.period === "custom") openRangePicker();
      else { period = { kind: target.dataset.period, from: null, to: null }; render(); }
      return;
    }
    const act = target.dataset.act;
    const card = target.closest(".med");
    const id = card ? Number(card.dataset.id) : null;
    switch (act) {
      case "close-sheet": if (e.target === target) closeSheet(); break;
      case "close-sheet-btn": closeSheet(); break;
      case "add": openEditor(null); break;
      case "edit": openEditor(id); break;
      case "delete": confirmDeleteId = id; render(); break;
      case "cancel-delete": confirmDeleteId = null; render(); break;
      case "confirm-delete": deleteMed(id); confirmDeleteId = null; render(); toast(t("deleted")); break;
      case "taken": markTaken(id); render(); toast(t("marked_taken")); break;
      case "history": view = "history"; window.scrollTo(0, 0); history_push(); render(); break;
      case "back": goHome(); break;
      case "lang": openLanguage(); break;
      case "settings": openSettings(); break;
      case "enable-alerts": enableAlerts(); break;
      case "install": doInstall(); break;
      case "pdf": exportPdf("download"); break;
      case "whatsapp": exportPdf("whatsapp"); break;
      case "email": exportPdf("email"); break;
      case "sound-test":
        if (testing || beepTimer) { testing = false; if (!ringing.length) stopSound(); }
        else { testing = true; startSound(); setTimeout(() => { if (testing) { testing = false; if (!ringing.length) stopSound(); renderSettings(); } }, 5000); }
        renderSettings(); break;
      case "export-data": exportData(); break;
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target.matches('[data-act="toggle"]')) {
      const id = Number(e.target.closest(".med").dataset.id);
      setEnabled(id, e.target.checked); render();
    }

  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openSheet) closeSheet(); });

  // Botón "atrás" del celular en el historial
  function history_push() { try { window.history.pushState({ v: "history" }, ""); } catch {} }
  function goHome() {
    if (window.history.state && window.history.state.v === "history") window.history.back();
    else { view = "home"; render(); }
  }
  window.addEventListener("popstate", () => { if (view === "history") { view = "home"; render(); } });

  // Al volver a la app: revisar alarmas pendientes y refrescar
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { tick(); render(); requestWakeLock(false); }
  });

  /* ---------- Service worker y acciones desde la notificación ---------- */
  function handleNotifAction(action, medId) {
    medId = Number(medId);
    if (!findMed(medId)) return;
    if (action === "taken") { markTaken(medId); toast(t("marked_taken")); }
    else if (action === "snooze") snooze(medId);
    else if (!ringing.includes(medId) && !takenToday(findMed(medId))) trigger(medId);
    render();
  }
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").then(r => { swReg = r; }).catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.type === "notif-action") handleNotifAction(e.data.action, e.data.medId);
    });
  }
  const params = new URLSearchParams(location.search);
  if (params.get("notif") && params.get("med")) {
    setTimeout(() => handleNotifAction(params.get("notif"), params.get("med")), 300);
    window.history.replaceState(null, "", location.pathname);
  }

  if (params.get("view") === "history") {
    view = "history";
    window.history.replaceState(null, "", location.pathname);
    history_push();
  }

  /* ---------- Arranque ---------- */
  render();
  tick();
  setInterval(tick, 10_000);
  // Refresca estados "Pendiente" cada minuto
  setInterval(() => { if (!openSheet && view === "home") render(); }, 60_000);
  requestWakeLock(false);

  // Para pruebas desde la consola
  window.MedsAlarm = { trigger, tick, get meds() { return meds; }, get history() { return history; } };
})();
