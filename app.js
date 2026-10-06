import * as shamsi from "./shamsi.js";
import * as db from "./db.js";
import * as timer from "./timer.js";
import { lineChart, monthKeys, MONTHS } from "./charts.js";
import { encodeSnapshot, decodeSnapshot } from "./share.js";

const { formatLong, formatShort, todayKey, parseKey, daysInJalaliMonth } = shamsi;
const { formatHMS, elapsedMs, createTimer, pauseTimer, resumeTimer, finishTimer, uid } = timer;
const GOLD = "#E6A817";
const DEFAULTS = [["زیست","#00A693"],["شیمی","#800040"],["فیزیک","#848482"],["ریاضی","#FF8200"],["زمین","#FE28A2"],["فارسی","#1C39BB"],["عربی","#93C572"],["دینی","#3E2723"],["انگلیسی","#FAD6A5"]];
const appEl = document.getElementById("app");
const miniEl = document.getElementById("mini");
const overlay = document.getElementById("overlay");
const sheet = document.getElementById("sheet");
const focusEl = document.getElementById("focus");
const printEl = document.getElementById("print");
const state = { today: todayKey(), viewing: todayKey(), settings: { dailyTargetSec: 10 * 3600, overlay: 0.45, timerFont: "system" }, catalog: [], day: null, days: [], notes: [], sessions: [], timer: null, panelBg: "", panelBgType: "", focusUrl: "", focusVideo: "" };

function hm(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h + ":" + String(m).padStart(2, "0");
}
function clamp(n) { return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0; }
function totalOf(s) { return (s.studySec || 0) + (s.testSec || 0); }
function dayTotal(day) { return Object.values(day?.subjects || {}).reduce((a, s) => a + totalOf(s), 0); }
function sleepDur(bed, wake) {
  const to = (t) => { const m = String(t || "").match(/(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 : null; };
  const b = to(bed), w = to(wake);
  if (b == null || w == null) return null;
  return w > b ? w - b : w + 86400 - b;
}
function snap(sub) { return { id: sub.id, name: sub.name, color: sub.color, targetSec: sub.targetSec, studySec: 0, testSec: 0, correct: 0, wrong: 0, blank: 0, quality: 0, dailyNote: "" }; }
function hexOk(v) { return /^#[0-9a-fA-F]{6}$/.test(v); }

document.getElementById("dock").onclick = (e) => {
  const nav = e.target.closest("[data-nav]")?.dataset.nav;
  if (!nav) return;
  if (!state.day) return alert("برنامه هنوز آماده نیست");
  if (nav === "manage") openManage();
  if (nav === "history") openHistory();
  if (nav === "stats") openStats();
  if (nav === "share") openShare();
};
appEl.onclick = (e) => {
  const open = e.target.closest("[data-open]");
  if (open) return openMenu(open.dataset.open);
  if (e.target.closest("[data-today]")) return go(state.today);
  if (e.target.closest("[data-note]")) return openNotes(e.target.closest("[data-note]").dataset.note);
  if (e.target.closest("[data-reset]")) return resetDay();
};
let lastTap = { id: "", t: 0 };
appEl.addEventListener("dblclick", (e) => { const el = e.target.closest("[data-dbl]"); if (el) onDouble(el.dataset.dbl); });
appEl.addEventListener("touchend", (e) => {
  const el = e.target.closest("[data-dbl]"); if (!el) return;
  const now = Date.now();
  if (lastTap.id === el.dataset.dbl && now - lastTap.t < 350) onDouble(el.dataset.dbl);
  lastTap = { id: el.dataset.dbl, t: now };
});
appEl.addEventListener("change", async (e) => {
  const q = e.target.closest("[data-q]"); if (!q || !state.day) return;
  state.day.subjects[q.dataset.q].quality = Number(q.value) || 0;
  await saveDay(); render();
});
miniEl.onclick = onMini;
window.addEventListener("scroll", () => { const s = document.querySelector(".sheen"); if (s) s.style.setProperty("--sheen", String(Math.round(window.scrollY * -0.2))); }, { passive: true });

async function boot() {
  if (location.hash.startsWith("#r=")) return renderReadonly(location.hash.slice(3));
  state.settings = (await db.kvGet("settings")) || state.settings;
  state.catalog = await db.all("subjects");
  if (!state.catalog.length) {
    state.catalog = DEFAULTS.map(([name, color]) => ({ id: uid("sub"), name, color, targetSec: 4 * 3600, active: true, createdAt: Date.now(), updatedAt: Date.now() }));
    for (const s of state.catalog) await db.put("subjects", s);
  }
  state.days = await db.all("days");
  state.notes = await db.all("notes");
  state.sessions = await db.all("sessions");
  state.timer = (await db.kvGet("activeTimer")) || null;
  const bg = await db.blobGet("panelBg");
  if (bg) { state.panelBg = URL.createObjectURL(bg); state.panelBgType = (await db.kvGet("panelBgType")) || "image"; }
  const img = await db.blobGet("focusImage"); if (img) state.focusUrl = URL.createObjectURL(img);
  const vid = await db.blobGet("focusVideo"); if (vid) state.focusVideo = URL.createObjectURL(vid);
  await ensure(state.today);
  state.viewing = state.today;
  state.day = await db.get("days", state.viewing);
  render();
  if (state.timer && state.timer.status !== "finished") openRecover();
  setInterval(() => { if (state.timer?.status === "running") { const b = miniEl.querySelector("b"); if (b) b.textContent = formatHMS(elapsedMs(state.timer)); const c = focusEl.querySelector(".clock"); if (c) c.textContent = formatHMS(elapsedMs(state.timer)); } }, 500);
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    const t = todayKey();
    if (t !== state.today) { state.today = t; await ensure(t); if (state.viewing !== t) state.viewing = t; state.day = await db.get("days", state.viewing); render(); }
  });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

async function ensure(date) {
  let day = await db.get("days", date);
  if (!day) {
    day = { date, targetSec: state.settings.dailyTargetSec || 36000, sleep: null, subjects: {}, updatedAt: Date.now() };
    state.catalog.filter((s) => s.active !== false).forEach((s) => { day.subjects[s.id] = snap(s); });
    await db.put("days", day);
  } else if (date === todayKey()) {
    state.catalog.filter((s) => s.active !== false).forEach((s) => {
      if (!day.subjects[s.id]) day.subjects[s.id] = snap(s);
      else { day.subjects[s.id].name = s.name; day.subjects[s.id].color = s.color; day.subjects[s.id].targetSec = s.targetSec; }
    });
    await db.put("days", day);
  }
  return day;
}
async function saveDay() { state.day.updatedAt = Date.now(); await db.put("days", state.day); const i = state.days.findIndex((d) => d.date === state.day.date); if (i >= 0) state.days[i] = state.day; else state.days.push(state.day); }
async function saveTimer() { await db.kvSet("activeTimer", state.timer); }

function render() {
  const day = state.day; if (!day) return;
  const total = dayTotal(day), target = day.targetSec || 1, pct = clamp(total / target * 100), remain = Math.max(0, target - total), remainPct = clamp(100 - pct);
  const upd = day.updatedAt ? new Date(day.updatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—";
  const past = state.viewing !== state.today;
  appEl.innerHTML = `${past ? `<div class="past"><span>روز گذشته ${formatShort(state.viewing)}</span><button class="ghost" data-today>امروز</button></div>` : ""}
  <section class="glass" id="panel">${state.panelBg ? (state.panelBgType === "video" ? `<video class="panel-bg" src="${state.panelBg}" autoplay muted loop playsinline></video>` : `<img class="panel-bg" alt="" src="${state.panelBg}">`) : ""}<div class="sheen"></div>
    <div class="topbar"><div><small>تاریخ</small><b>${formatLong(state.viewing)}</b></div><div><small>آخرین به‌روزرسانی</small><b>${upd}</b></div></div>
    <div class="daily">${ring(pct, GOLD, Math.round(pct) + "%", "روز")}
      <div><div class="meter-top"><div><span class="k">مطالعه شده</span><span class="v">${hm(total)}</span></div><div><span class="k">باقی مانده</span><span class="v">${hm(remain)}</span></div></div>
      <div class="track"><i style="width:${pct}%;background:${GOLD}"></i></div><div class="meter-bot">${remainPct.toFixed(0)}%</div></div>
    </div>
    ${sleepBlock(day)}${Object.values(day.subjects).map(subjectBlock).join("")}
    <button class="ghost reset-day" data-reset>ریست این روز</button>
  </section>`;
  renderMini();
}
function ring(pct, color, main, sub) {
  const c = 2 * Math.PI * 42, dash = clamp(pct) / 100 * c;
  return `<div class="ring"><svg width="108" height="108" viewBox="0 0 108 108"><circle cx="54" cy="54" r="42" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="8"/><circle cx="54" cy="54" r="42" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${dash} ${c}"/></svg><div class="lab"><div><strong>${main}</strong><br><small>${sub}</small></div></div></div>`;
}
function sleepBlock(day) {
  if (!day.sleep?.bed || !day.sleep?.wake) return "";
  const dur = sleepDur(day.sleep.bed, day.sleep.wake);
  const { jy, jm } = parseKey(day.date);
  const rows = state.days.filter((d) => d.date.startsWith(`${jy}-${String(jm).padStart(2, "0")}`) && d.sleep?.bed);
  const avg = rows.length ? rows.reduce((a, d) => a + (sleepDur(d.sleep.bed, d.sleep.wake) || 0), 0) / rows.length : dur;
  return `<div class="sleep-grid"><div class="sq"><small>ساعت خواب</small><b>${day.sleep.bed}</b></div><div class="sq"><small>ساعت بیداری</small><b>${day.sleep.wake}</b></div><div class="sq"><small>مقدار خواب امروز</small><b>${hm(dur || 0)}</b></div><div class="sq"><small>میانگین مقدار ساعت خواب</small><b>${hm(avg || 0)}</b></div></div>`;
}
function subjectBlock(s) {
  const sum = totalOf(s), pct = s.targetSec ? clamp(sum / s.targetSec * 100) : 0, share = sum ? (s.testSec || 0) / sum * 100 : 0;
  const note = s.dailyNote || state.notes.find((n) => n.subjectId === s.id)?.text || "";
  return `<article class="subject"><div class="subject-head"><button class="subject-name" data-open="${s.id}" style="color:${s.color}">${s.name}</button><span>${Math.round(pct)}%</span></div>
    <div class="track"><i style="width:${pct}%;background:${s.color}"></i></div>
    <div class="goal-line">${hm(sum)} . هدف: ${hm(s.targetSec || 0)}</div>
    ${sum || s.correct || s.wrong || s.blank ? `<div class="split"><div><div class="fine"><span data-dbl="study:${s.id}">مطالعه</span><span data-dbl="edit-study:${s.id}">${hm(s.studySec || 0)}</span></div><div class="track" data-dbl="study:${s.id}"><i style="width:${sum ? (s.studySec / sum * 100) : 0}%;background:${s.color}"></i></div></div>
      <div><div class="mini-ring"><svg width="72" height="72" viewBox="0 0 72 72"><circle cx="36" cy="36" r="28" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="5"/><circle cx="36" cy="36" r="28" fill="none" stroke="${s.color}" stroke-width="5" stroke-dasharray="${share / 100 * 176} 176"/></svg><span data-dbl="test:${s.id}">تست</span></div><div class="test-time" data-dbl="edit-test:${s.id}">${hm(s.testSec || 0)}</div></div></div>` : ""}
    <label class="quality"><span>کیفیت</span><i><b style="width:${(s.quality || 0) * 10}%;background:${s.color}"></b></i><input data-q="${s.id}" type="range" min="0" max="10" value="${s.quality || 0}"></label>
    ${note ? `<button class="ghost" data-note="${s.id}" style="margin-top:8px;width:100%;text-align:right">${note.slice(0, 42)}</button>` : ""}</article>`;
}
function renderMini() {
  const t = state.timer;
  if (!t || t.status === "finished" || focusEl.classList.contains("open")) { miniEl.classList.remove("show"); return; }
  const sub = state.catalog.find((s) => s.id === t.subjectId);
  miniEl.classList.add("show");
  miniEl.innerHTML = `<div><small>${sub?.name || ""} / ${t.activity === "test" ? "تست" : "مطالعه"}</small><b>${formatHMS(elapsedMs(t))}</b></div><div class="row-actions"><button class="ghost" data-act="pause">${t.status === "paused" ? "ادامه" : "مکث"}</button><button class="ghost" data-act="finish">پایان</button><button class="ghost" data-act="full">تمام‌صفحه</button></div>`;
}
function onDouble(key) {
  const [kind, id] = key.split(":");
  if (kind === "study" || kind === "test") startTimer(id, kind);
  if (kind === "edit-study" || kind === "edit-test") editTime(id, kind === "edit-test" ? "testSec" : "studySec");
}
function openSheet(html) { sheet.innerHTML = html; overlay.classList.add("open"); sheet.querySelectorAll("[data-close]").forEach((b) => b.onclick = closeSheet); }
function closeSheet() { overlay.classList.remove("open"); }
overlay.onclick = (e) => { if (e.target === overlay) closeSheet(); };

function openMenu(id) {
  openSheet(`<h3>${state.day.subjects[id].name}</h3><div class="row-actions" style="flex-wrap:wrap"><button class="ghost" data-a="study">زمان مطالعه</button><button class="ghost" data-a="test">زمان تست</button><button class="ghost" data-a="c">صحیح</button><button class="ghost" data-a="w">غلط</button><button class="ghost" data-a="b">نزده</button><button class="ghost" data-a="note">یادداشت</button><button class="ghost" data-close>بستن</button></div>`);
  sheet.onclick = (e) => { const a = e.target.closest("[data-a]")?.dataset.a; if (!a) return; if (a === "note") return openNotes(id); askAdd(id, a); };
}
function askAdd(id, kind) {
  const time = kind === "study" || kind === "test";
  openSheet(`<h3>افزودن</h3>${time ? `<div class="field"><label>ساعت</label><input id="hh" type="number" min="0" max="24" value="0"></div><div class="field"><label>دقیقه</label><input id="mm" type="number" min="0" max="59" value="0"></div>` : `<div class="field"><label>تعداد</label><input id="nn" type="number" min="0" value="1"></div>`}<button class="primary" id="ok">ثبت</button>`);
  sheet.querySelector("#ok").onclick = async () => {
    const s = state.day.subjects[id];
    if (time) { const hh = Number(sheet.querySelector("#hh").value) || 0, mm = Number(sheet.querySelector("#mm").value) || 0; if (mm > 59 || hh < 0) return alert("زمان نامعتبر است"); const sec = hh * 3600 + mm * 60; if (kind === "study") s.studySec += sec; else s.testSec += sec; }
    else { const n = Number(sheet.querySelector("#nn").value) || 0; if (n < 0) return; if (kind === "c") s.correct += n; if (kind === "w") s.wrong += n; if (kind === "b") s.blank += n; }
    await saveDay(); closeSheet(); render();
  };
}
function editTime(id, field) {
  const s = state.day.subjects[id]; const cur = hm(s[field] || 0).split(":");
  openSheet(`<h3>اصلاح</h3><div class="field"><label>ساعت</label><input id="hh" type="number" value="${cur[0]}"></div><div class="field"><label>دقیقه</label><input id="mm" type="number" value="${cur[1]}"></div><button class="primary" id="ok">ذخیره</button>`);
  sheet.querySelector("#ok").onclick = async () => { s[field] = (Number(sheet.querySelector("#hh").value) || 0) * 3600 + (Number(sheet.querySelector("#mm").value) || 0) * 60; await saveDay(); closeSheet(); render(); };
}
async function startTimer(subjectId, activity) {
  if (state.timer && state.timer.status !== "finished") {
    if (state.timer.subjectId === subjectId && state.timer.activity === activity) { if (state.timer.status === "paused") state.timer = resumeTimer(state.timer); await saveTimer(); return render(); }
    if (!confirm("تایمر فعلی متوقف و تایمر جدید شروع شود؟")) return;
    await finishActive();
  }
  state.timer = createTimer({ subjectId, activity, date: state.viewing });
  await saveTimer(); render();
}
async function finishActive() {
  if (!state.timer || state.timer.persisted) return;
  state.timer.persisted = true; state.timer = finishTimer(state.timer);
  const sec = Math.round(elapsedMs(state.timer, state.timer.finishedAt) / 1000);
  const day = await db.get("days", state.timer.date);
  if (day?.subjects[state.timer.subjectId] && sec > 0) { const s = day.subjects[state.timer.subjectId]; if (state.timer.activity === "test") s.testSec += sec; else s.studySec += sec; await db.put("days", day); if (day.date === state.viewing) state.day = day; }
  await db.put("sessions", { id: state.timer.id, subjectId: state.timer.subjectId, activity: state.timer.activity, date: state.timer.date, startTime: state.timer.segments[0]?.start, endTime: state.timer.finishedAt, duration: sec, status: "finished" });
  state.sessions.push({ id: state.timer.id, subjectId: state.timer.subjectId, date: state.timer.date, duration: sec, activity: state.timer.activity, status: "finished" });
  state.timer = null; await saveTimer(); render();
}
function onMini(e) {
  const act = e.target.closest("[data-act]")?.dataset.act; if (!act || !state.timer) return;
  if (act === "pause") { state.timer = state.timer.status === "paused" ? resumeTimer(state.timer) : pauseTimer(state.timer); saveTimer().then(render); }
  if (act === "finish") finishActive();
  if (act === "full") openFocus();
}
function openFocus() {
  const sub = state.catalog.find((s) => s.id === state.timer.subjectId);
  focusEl.classList.add("open");
  focusEl.style.backgroundImage = state.focusUrl && !state.focusVideo ? `url(${state.focusUrl})` : "none";
  focusEl.innerHTML = `${state.focusVideo ? `<video src="${state.focusVideo}" autoplay muted loop playsinline></video>` : ""}<div class="dim" style="background:#000;opacity:${state.settings.overlay || 0.45}"></div><div class="ui"><div>${sub?.name || ""}</div><div>${state.timer.activity === "test" ? "تست" : "مطالعه"}</div><div class="clock">${formatHMS(elapsedMs(state.timer))}</div><div class="row-actions" style="justify-content:center"><button class="ghost" id="fp">مکث</button><button class="primary" id="ff">پایان</button><button class="ghost" id="fs">تمام‌صفحه</button><button class="ghost" id="fe">خروج</button></div></div>`;
  focusEl.querySelector("#fp").onclick = async () => { state.timer = state.timer.status === "paused" ? resumeTimer(state.timer) : pauseTimer(state.timer); await saveTimer(); };
  focusEl.querySelector("#ff").onclick = async () => { focusEl.classList.remove("open"); document.exitFullscreen?.(); await finishActive(); };
  focusEl.querySelector("#fe").onclick = () => { focusEl.classList.remove("open"); document.exitFullscreen?.(); render(); };
  focusEl.querySelector("#fs").onclick = () => document.fullscreenElement ? document.exitFullscreen() : focusEl.requestFullscreen?.();
}
function openRecover() {
  openSheet(`<h3>جلسه ناتمام</h3><div class="row-actions"><button class="primary" id="rc">ادامه</button><button class="ghost" id="rf">پایان</button><button class="danger" id="rd">حذف</button></div>`);
  sheet.querySelector("#rc").onclick = async () => { if (state.timer.status === "paused") state.timer = resumeTimer(state.timer); await saveTimer(); closeSheet(); render(); };
  sheet.querySelector("#rf").onclick = async () => { closeSheet(); await finishActive(); };
  sheet.querySelector("#rd").onclick = async () => { if (!confirm("حذف شود؟")) return; state.timer = null; await saveTimer(); closeSheet(); render(); };
}
async function resetDay() {
  if (!confirm("همه اطلاعات همین روز پاک شود؟")) return;
  const date = state.day.date, target = state.day.targetSec;
  state.day = { date, targetSec: target, sleep: null, subjects: {}, updatedAt: Date.now() };
  state.catalog.filter((s) => s.active !== false).forEach((s) => { state.day.subjects[s.id] = snap(s); });
  await saveDay(); render();
}
function openManage() {
  const rows = state.catalog.filter((s) => s.active !== false).map((s) => `<div class="field"><label>${s.name}</label><input data-id="${s.id}" data-k="name" value="${s.name}"><input data-id="${s.id}" data-k="color" value="${s.color}" placeholder="#00A693"><input data-id="${s.id}" data-k="target" value="${hm(s.targetSec)}"><button class="danger" data-del="${s.id}">حذف</button></div>`).join("");
  openSheet(`<h3>مدیریت</h3><div class="field"><label>هدف روزانه ساعت:دقیقه</label><input id="dt" value="${hm(state.settings.dailyTargetSec)}"></div><div class="field"><label>خواب</label><input id="bed" placeholder="23:45" value="${state.day.sleep?.bed || ""}"></div><div class="field"><label>بیداری</label><input id="wake" placeholder="07:15" value="${state.day.sleep?.wake || ""}"></div><p style="color:#aaa;font-size:.75rem">رنگ را با کد مثل #00A693 عوض کن. فقط امروز و روزهای بعد عوض می‌شود.</p>${rows}<div class="field"><label>درس جدید</label><input id="nn"></div><div class="row-actions"><button class="primary" id="save">ذخیره</button><button class="ghost" id="add">افزودن</button><button class="ghost" id="pbg">پس‌زمینه پنل</button><button class="ghost" id="fimg">تصویر تمرکز</button><button class="ghost" id="fvid">ویدیو تمرکز</button><button class="ghost" data-close>بستن</button></div><input id="pfile" type="file" accept="image/*,video/*" hidden><input id="ifile" type="file" accept="image/*" hidden><input id="vfile" type="file" accept="video/*" hidden>`);
  sheet.querySelector("#pbg").onclick = () => sheet.querySelector("#pfile").click();
  sheet.querySelector("#fimg").onclick = () => sheet.querySelector("#ifile").click();
  sheet.querySelector("#fvid").onclick = () => sheet.querySelector("#vfile").click();
  sheet.querySelector("#pfile").onchange = async (e) => { const f = e.target.files?.[0]; if (!f) return; await db.blobSet("panelBg", f); state.panelBgType = f.type.startsWith("video") ? "video" : "image"; await db.kvSet("panelBgType", state.panelBgType); state.panelBg = URL.createObjectURL(f); render(); };
  sheet.querySelector("#ifile").onchange = async (e) => { const f = e.target.files?.[0]; if (!f) return; await db.blobSet("focusImage", f); state.focusUrl = URL.createObjectURL(f); };
  sheet.querySelector("#vfile").onchange = async (e) => { const f = e.target.files?.[0]; if (!f) return; await db.blobSet("focusVideo", f); state.focusVideo = URL.createObjectURL(f); };
  sheet.querySelector("#add").onclick = async () => { const name = sheet.querySelector("#nn").value.trim(); if (!name) return; const sub = { id: uid("sub"), name, color: GOLD, targetSec: 7200, active: true, createdAt: Date.now(), updatedAt: Date.now() }; state.catalog.push(sub); await db.put("subjects", sub); state.day.subjects[sub.id] = snap(sub); await saveDay(); openManage(); render(); };
  sheet.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => { if (!confirm("حذف شود؟")) return; const sub = state.catalog.find((s) => s.id === b.dataset.del); sub.active = false; await db.put("subjects", sub); if (state.day.subjects[sub.id] && !totalOf(state.day.subjects[sub.id])) delete state.day.subjects[sub.id]; await saveDay(); openManage(); render(); });
  sheet.querySelector("#save").onclick = async () => {
    const [h, m] = sheet.querySelector("#dt").value.split(":").map(Number); state.settings.dailyTargetSec = (h || 0) * 3600 + (m || 0) * 60; await db.kvSet("settings", state.settings); state.day.targetSec = state.settings.dailyTargetSec;
    const bed = sheet.querySelector("#bed").value.trim(), wake = sheet.querySelector("#wake").value.trim(); if (bed && wake) state.day.sleep = { bed, wake };
    sheet.querySelectorAll("[data-id]").forEach((input) => { const sub = state.catalog.find((s) => s.id === input.dataset.id); if (!sub) return; if (input.dataset.k === "name" && input.value.trim()) sub.name = input.value.trim(); if (input.dataset.k === "color" && hexOk(input.value.trim())) sub.color = input.value.trim(); if (input.dataset.k === "target") { const [hh, mm] = input.value.split(":").map(Number); sub.targetSec = (hh || 0) * 3600 + (mm || 0) * 60; } });
    for (const sub of state.catalog) await db.put("subjects", sub);
    if (state.viewing === state.today) state.catalog.filter((s) => s.active !== false).forEach((s) => { if (state.day.subjects[s.id]) { state.day.subjects[s.id].name = s.name; state.day.subjects[s.id].color = s.color; state.day.subjects[s.id].targetSec = s.targetSec; } });
    await saveDay(); closeSheet(); render();
  };
}
async function go(date) { await ensure(date); state.viewing = date; state.day = await db.get("days", date); closeSheet(); render(); }
function openHistory() {
  const { jy } = parseKey(state.today);
  openSheet(`<h3>تاریخچه ${jy}</h3><div class="row-actions" style="flex-wrap:wrap">${MONTHS.map((m, i) => `<button class="ghost" data-m="${i + 1}">${m}</button>`).join("")}</div>`);
  sheet.querySelectorAll("[data-m]").forEach((b) => b.onclick = () => openMonth(jy, Number(b.dataset.m)));
}
async function openMonth(year, month) {
  const map = Object.fromEntries((await db.all("days")).map((d) => [d.date, d]));
  let html = "";
  for (let d = 1; d <= daysInJalaliMonth(year, month); d++) {
    const key = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const rec = map[key]; const sum = rec ? dayTotal(rec) : 0;
    html += `<button class="ghost" data-date="${key}" style="width:100%;margin:4px 0;opacity:${sum ? 1 : .45}">${d} ${MONTHS[month - 1]} ${sum ? hm(sum) : ""}</button>`;
  }
  openSheet(`<h3>${MONTHS[month - 1]}</h3>${html}<button class="ghost" id="back">ماه‌ها</button>`);
  sheet.querySelector("#back").onclick = openHistory;
  sheet.querySelectorAll("[data-date]").forEach((b) => b.onclick = () => go(b.dataset.date));
}
async function openStats() {
  openSheet(`<h3>آمار ماهانه</h3><div class="field"><select id="ms">${MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("")}</select></div><div class="row-actions"><button class="ghost" data-tab="study">مطالعه</button><button class="ghost" data-tab="test">تست</button><button class="ghost" data-tab="sleep">خواب</button></div><div id="chart"></div><p style="color:#aaa;font-size:.75rem">افقی: روز ماه. عمودی: ساعت مطالعه، تعداد تست، یا ساعت خواب.</p>`);
  const draw = async (tab) => {
    const month = Number(sheet.querySelector("#ms").value);
    const { jy } = parseKey(state.viewing);
    const map = Object.fromEntries((await db.all("days")).map((d) => [d.date, d]));
    const points = monthKeys(jy, month).slice(0, daysInJalaliMonth(jy, month)).map((date) => {
      const rec = map[date]; if (!rec) return { date, value: 0 };
      if (tab === "test") return { date, value: Object.values(rec.subjects).reduce((a, s) => a + (s.correct || 0) + (s.wrong || 0) + (s.blank || 0), 0) };
      if (tab === "sleep") return { date, value: Math.round(((sleepDur(rec.sleep?.bed, rec.sleep?.wake) || 0) / 3600) * 10) / 10 };
      return { date, value: Math.round((dayTotal(rec) / 3600) * 10) / 10 };
    });
    lineChart(sheet.querySelector("#chart"), points, tab === "test" ? "#ff5d5d" : tab === "sleep" ? "#7eb6ff" : GOLD, (sum) => tab === "test" ? `مجموع تست ${sum}` : `مجموع ساعت ${Math.round(sum * 10) / 10}`);
  };
  sheet.querySelector("#ms").onchange = () => draw("study");
  sheet.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => draw(b.dataset.tab));
  draw("study");
}
function openNotes(id) {
  const s = state.day.subjects[id]; const perm = state.notes.find((n) => n.subjectId === id);
  openSheet(`<h3>یادداشت</h3><div class="field"><label>دائمی</label><textarea id="p">${perm?.text || ""}</textarea></div><div class="field"><label>همین روز</label><textarea id="d">${s.dailyNote || ""}</textarea></div><button class="primary" id="ok">ذخیره</button>`);
  sheet.querySelector("#ok").onclick = async () => {
    const text = sheet.querySelector("#p").value.trim();
    if (perm) { perm.text = text; await db.put("notes", perm); } else if (text) { const note = { id: uid("note"), subjectId: id, kind: "permanent", text, updatedAt: Date.now() }; state.notes.push(note); await db.put("notes", note); }
    s.dailyNote = sheet.querySelector("#d").value.trim(); await saveDay(); closeSheet(); render();
  };
}
function openShare() {
  openSheet(`<h3>اشتراک پنل همین روز</h3><button class="primary" id="img">PNG</button><button class="ghost" id="pdf">PDF</button><button class="ghost" id="link">لینک</button><button class="ghost" data-close>بستن</button>`);
  sheet.querySelector("#img").onclick = sharePng;
  sheet.querySelector("#pdf").onclick = () => { printEl.innerHTML = document.getElementById("panel").outerHTML; window.print(); };
  sheet.querySelector("#link").onclick = async () => { const url = location.origin + location.pathname + "#r=" + encodeSnapshot({ day: state.day }); try { await navigator.clipboard.writeText(url); alert("لینک کپی شد. سروری برای حذف ندارد."); } catch { prompt("لینک", url); } };
}
async function sharePng() {
  const day = state.day, total = dayTotal(day), target = day.targetSec || 1, pct = clamp(total / target * 100), remain = Math.max(0, target - total);
  const c = document.createElement("canvas"); c.width = 1080; c.height = 1680; const g = c.getContext("2d");
  g.fillStyle = "#000"; g.fillRect(0, 0, 1080, 1680); g.strokeStyle = "rgba(255,255,255,.2)"; g.strokeRect(36, 36, 1008, 1608);
  g.fillStyle = "#fff"; g.font = "700 34px Tahoma"; g.textAlign = "right"; g.fillText(formatLong(day.date), 1000, 110); g.textAlign = "left"; g.fillText(day.updatedAt ? new Date(day.updatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "", 60, 110);
  drawRing(g, 180, 250, 70, pct, GOLD, Math.round(pct) + "%");
  g.textAlign = "right"; g.font = "400 24px Tahoma"; g.fillText("مطالعه شده", 1000, 200); g.font = "700 42px Tahoma"; g.fillText(hm(total), 1000, 250);
  g.textAlign = "left"; g.font = "400 24px Tahoma"; g.fillText("باقی مانده", 280, 200); g.font = "700 42px Tahoma"; g.fillText(hm(remain), 280, 250);
  g.fillStyle = "rgba(255,255,255,.12)"; g.fillRect(280, 280, 700, 14); g.fillStyle = GOLD; g.fillRect(280, 280, 700 * pct / 100, 14);
  g.fillStyle = "#fff"; g.textAlign = "right"; g.font = "700 28px Tahoma"; g.fillText((100 - pct).toFixed(0) + "%", 1000, 330);
  let y = 420;
  Object.values(day.subjects).forEach((s) => { const sum = totalOf(s), sp = s.targetSec ? clamp(sum / s.targetSec * 100) : 0; g.fillStyle = s.color; g.fillRect(980, y - 16, 12, 24); g.fillStyle = "#fff"; g.textAlign = "right"; g.font = "600 28px Tahoma"; g.fillText(s.name, 960, y); g.textAlign = "left"; g.font = "400 22px Tahoma"; g.fillText(hm(sum) + " . هدف: " + hm(s.targetSec || 0), 60, y); drawRing(g, 120, y + 70, 26, sum ? (s.testSec || 0) / sum * 100 : 0, s.color, "تست"); g.fillStyle = "#fff"; g.fillText(hm(s.testSec || 0), 160, y + 76); y += 120; });
  const blob = await new Promise((res) => c.toBlob(res, "image/png"));
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `panel-${day.date}.png`; document.body.appendChild(a); a.click(); a.remove();
  const file = new File([blob], a.download, { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file] }); } catch {} }
}
function drawRing(g, x, y, r, pct, color, label) {
  g.beginPath(); g.strokeStyle = "rgba(255,255,255,.15)"; g.lineWidth = 10; g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.strokeStyle = color; g.lineCap = "round"; g.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + clamp(pct) / 100 * Math.PI * 2); g.stroke();
  g.fillStyle = "#fff"; g.font = "700 18px Tahoma"; g.textAlign = "center"; g.fillText(label, x, y + 6);
}
function renderReadonly(token) {
  document.getElementById("dock").style.display = "none";
  try { state.day = decodeSnapshot(token).day; state.viewing = state.day.date; state.today = state.day.date; state.days = [state.day]; state.notes = []; state.catalog = []; render(); }
  catch { appEl.innerHTML = "<p>لینک نامعتبر است.</p>"; }
}
boot().catch((err) => { appEl.innerHTML = `<p style="color:#fff;background:#3a1010;padding:12px;border-radius:12px">خطا: ${err.message}</p>`; });
