// ===== 設定區（使用者填入 Firebase Console 提供的內容）=====
// firebaseConfig 可以公開。請不要把真實 Email 寫進這個檔案，Email 只放在 Firebase Console 的安全規則。
const firebaseConfig = {
  apiKey: "AIzaSyDE6qlIvVEtcpwuKHzbO4iX2UEuiMGk7x4",
  authDomain: "shared-ledger-australia.firebaseapp.com",
  projectId: "shared-ledger-australia",
  storageBucket: "shared-ledger-australia.firebasestorage.app",
  messagingSenderId: "795858544103",
  appId: "1:795858544103:web:42a3cf34ed5ef342c18942",
};
const FIREBASE_VERSION = "13.2.0";
const SAVE_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 10000;
// ===== 設定區結束 =====

// ---------- 金額與日期（純函式）----------

const MAX_CENTS = 99999999;

/** 把輸入字串轉成澳分整數，全程不經浮點數。不合法回傳 null；空字串回傳 emptyValue。 */
export function parseMoney(input, emptyValue = null) {
  const s = String(input ?? "").trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (s === "") return emptyValue;
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m || (m[1] === "" && !m[2])) return null;
  const cents = Number(m[1] || "0") * 100 + Number((m[2] || "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents <= MAX_CENTS ? cents : null;
}

/** 8000 → "80.00"（複製到 Excel 與輸入框用） */
export function centsPlain(c) {
  const a = Math.abs(c);
  return `${c < 0 ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

/** 123450 → "$1,234.50" */
export function formatMoney(c) {
  const a = Math.abs(c);
  const dollars = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${c < 0 ? "-" : ""}$${dollars}.${String(a % 100).padStart(2, "0")}`;
}

export function sharedCents(e) {
  return e.totalCents - e.payerPersonalCents - e.otherPersonalCents;
}

/** 對方應付：對方的個人用品 + 共同金額的一半（單數分由付款人吸收） */
export function owedCents(e) {
  return e.otherPersonalCents + Math.floor(sharedCents(e) / 2);
}

/** 我實際負擔的金額 */
export function myCost(e, me) {
  return e.paidBy === me ? e.totalCents - owedCents(e) : owedCents(e);
}

/**
 * 把一筆消費拆成「我負擔」的各列。沒有細項時回傳一列。
 * 共同金額的單數分由付款人吸收，且各列加總一定等於 myCost。
 */
export function shareRows(e, me) {
  const lines = e.lines || [];
  if (!lines.length) {
    const c = myCost(e, me);
    return c > 0 ? [{ detail: "", cents: c }] : [];
  }
  const items = lines.map((l) => ({
    detail: l.name,
    cents: l.cents,
    who: l.owner === "shared" ? "shared" : l.owner === e.paidBy ? "payer" : "other",
  }));
  const sum = (who) => items.filter((i) => i.who === who).reduce((a, i) => a + i.cents, 0);
  const restPayer = e.payerPersonalCents - sum("payer");
  const restOther = e.otherPersonalCents - sum("other");
  const restShared = sharedCents(e) - sum("shared");
  if (restShared > 0) items.push({ detail: "其他", cents: restShared, who: "shared" });
  if (restPayer > 0) items.push({ detail: "其他", cents: restPayer, who: "payer" });
  if (restOther > 0) items.push({ detail: "其他", cents: restOther, who: "other" });

  // 先給每個共同項目一半（無條件捨去），再把對方還沒分完的 1 分補到單數項目
  const shared = items.filter((i) => i.who === "shared");
  let left = Math.floor(shared.reduce((a, i) => a + i.cents, 0) / 2) - shared.reduce((a, i) => a + Math.floor(i.cents / 2), 0);
  for (const i of shared) {
    i.otherShare = Math.floor(i.cents / 2);
    if (left > 0 && i.cents % 2) { i.otherShare += 1; left -= 1; }
  }
  const iPaid = e.paidBy === me;
  return items
    .map((i) => {
      let cents;
      if (i.who === "shared") cents = iPaid ? i.cents - i.otherShare : i.otherShare;
      else cents = (i.who === "payer") === iPaid ? i.cents : 0;
      return { detail: i.detail, cents };
    })
    .filter((i) => i.cents > 0);
}

/** net > 0：對方欠我；net < 0：我欠對方 */
export function computeNet(entries, me) {
  let net = 0;
  for (const e of entries) {
    if (e.deletedAt) continue;
    const delta = e.kind === "repayment" ? e.totalCents : owedCents(e);
    net += e.paidBy === me ? delta : -delta;
  }
  return net;
}

/** 手機當地日期。不可用 toISOString()，否則澳洲早上會變成昨天。 */
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function monthRange(offset, now = new Date()) {
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const last = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
  return { from: localDate(first), to: localDate(last) };
}

export function shortDate(date, now = new Date()) {
  const [y, m, d] = date.split("-").map(Number);
  return y === now.getFullYear() ? `${m}/${d}` : `${y}/${m}/${d}`;
}

const slashDate = (date) => date.replaceAll("-", "/");

/** 我的花費：回傳篩選後、由舊到新的列 */
export function spendRows(entries, me, from, to) {
  return entries
    .filter((e) => !e.deletedAt && e.kind === "expense")
    .flatMap((e) => shareRows(e, me).map((r, index) => ({ date: e.date, item: e.item, detail: r.detail, cents: r.cents, order: ms(e.createdAt), index })))
    .filter((r) => (!from || r.date >= from) && (!to || r.date <= to))
    .sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order || a.index - b.index);
}

/** 複製到 Excel 的 Tab 分隔文字。以公式字元開頭的項目加上空白，Excel 會當成文字。 */
export function toTsv(rows) {
  const clean = (s) => {
    const one = String(s).replace(/[\t\r\n]+/g, " ");
    return /^[=+\-@]/.test(one) ? ` ${one}` : one;
  };
  return ["日期\t項目\t細項\t金額", ...rows.map((r) => `${r.date}\t${clean(r.item)}\t${clean(r.detail)}\t${centsPlain(r.cents)}`)].join("\r\n");
}

/** CSV 欄位：處理引號，並阻止 Excel 執行公式 */
export function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function ms(ts) {
  return ts && ts.toMillis ? ts.toMillis() : 0;
}

function timeText(ts) {
  if (!ts || !ts.toDate) return "";
  const d = ts.toDate();
  return `${shortDate(localDate(d))} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ---------- 畫面工具 ----------

/** 建立元素。文字一律走 textContent，不組 HTML。 */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c !== null && c !== undefined && c !== false) el.append(c);
  }
  return el;
}

const $ = (id) => document.getElementById(id);

function confirmDialog({ title, body, ok = "確定", cancel = "取消", danger = false }) {
  const dialog = $("dialog");
  return new Promise((resolve) => {
    const finish = (value) => {
      dialog.oncancel = null;
      dialog.close();
      resolve(value);
    };
    const okBtn = h("button", { class: `btn ${danger ? "solid-danger" : "primary"}`, type: "button", onclick: () => finish(true) }, ok);
    const cancelBtn = h("button", { class: "btn", type: "button", onclick: () => finish(false) }, cancel);
    dialog.replaceChildren(h("h2", {}, title), body ? h("p", {}, body) : "", h("div", { class: "actions" }, cancelBtn, okBtn));
    dialog.oncancel = (ev) => { ev.preventDefault(); finish(false); }; // Esc
    dialog.showModal();
    cancelBtn.focus();
  });
}

let toastTimer = null;
function toast(message, action) {
  const el = $("toast");
  clearTimeout(toastTimer);
  el.replaceChildren(h("span", {}, message));
  if (action) {
    el.append(h("button", { type: "button", onclick: () => { el.hidden = true; action.run(); } }, action.label));
  }
  el.hidden = false;
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 5000 : 3000);
}

// ---------- 狀態 ----------

const S = {
  gate: "loading", // loading | unconfigured | sdkError | login | denied | neterror | setup | app | quota
  user: null,
  deniedEmail: "",
  loginError: "",
  members: {},
  membersLoaded: false,
  entries: [],
  entriesLoaded: false,
  stale: false,
  quota: false,
  route: "home",
  routeId: null,
  formDirty: false,
  formKey: null,
  historyOpen: false,
  spend: { preset: "month", from: "", to: "", draftFrom: "", draftTo: "", error: "" },
};

let fb = null; // Firebase 模組
let auth = null;
let db = null;
let unsubs = [];
let connectTimer = null;

const me = () => S.user?.uid;
const memberIds = () => Object.keys(S.members);
const otherUid = () => memberIds().find((id) => id !== me()) ?? null;
const memberName = (uid) => S.members[uid]?.name || "對方";
const nameOf = (uid) => (uid === me() ? "你" : uid === null ? "對方" : memberName(uid));
const otherName = () => memberName(otherUid());
const activeEntries = () => S.entries.filter((e) => !e.deletedAt);
const findEntry = (id) => S.entries.find((e) => e.id === id);
const tooManyMembers = () => memberIds().length > 2;

function compareEntries(a, b) {
  return b.date.localeCompare(a.date) || ms(b.createdAt) - ms(a.createdAt);
}

// ---------- Firebase 連線 ----------

function stopListeners() {
  unsubs.forEach((u) => u());
  unsubs = [];
  clearTimeout(connectTimer);
}

function handleListenerError(err) {
  if (!S.user) return;
  if (err.code === "permission-denied") {
    S.deniedEmail = S.user?.email || "";
    S.gate = "denied";
    stopListeners();
    render();
    fb.signOut(auth);
    return;
  }
  if (err.code === "resource-exhausted") {
    S.quota = true;
    render();
    return;
  }
  if (S.gate !== "app") {
    S.gate = "neterror";
    render();
  } else {
    S.stale = true;
    render();
  }
}

function startListeners() {
  stopListeners();
  S.membersLoaded = false;
  S.entriesLoaded = false;
  S.gate = "loading";
  render();
  connectTimer = setTimeout(() => {
    if (!S.membersLoaded) {
      S.gate = "neterror";
      render();
    }
  }, CONNECT_TIMEOUT_MS);

  unsubs.push(fb.onSnapshot(fb.collection(db, "members"), { includeMetadataChanges: true }, (snap) => {
    // 離線時的空快取不代表沒有成員，不可誤導到首次設定
    if (snap.metadata.fromCache && !S.membersLoaded) return;
    S.members = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
    S.membersLoaded = true;
    clearTimeout(connectTimer);
    S.gate = S.members[me()] ? "app" : "setup";
    render();
  }, handleListenerError));

  unsubs.push(fb.onSnapshot(fb.collection(db, "entries"), { includeMetadataChanges: true }, (snap) => {
    if (snap.metadata.fromCache && !S.entriesLoaded) return;
    S.entries = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) })).sort(compareEntries);
    S.entriesLoaded = true;
    S.stale = snap.metadata.fromCache;
    S.quota = false;
    render();
  }, handleListenerError));
}

function clearSession() {
  S.user = null;
  S.members = {};
  S.entries = [];
  S.membersLoaded = false;
  S.entriesLoaded = false;
  S.formDirty = false;
  S.formKey = null;
}

async function login() {
  S.loginError = "";
  try {
    const provider = new fb.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await fb.signInWithPopup(auth, provider);
  } catch (err) {
    if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") return;
    S.loginError = err.code === "auth/popup-blocked"
      ? "瀏覽器擋住了登入視窗。請允許彈出視窗後再試一次。"
      : `無法登入，請稍後再試（${err.code || "未知錯誤"}）。`;
    render();
  }
}

function withTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject({ code: "timeout" }), SAVE_TIMEOUT_MS)),
  ]);
}

function saveErrorText(err) {
  if (err?.code === "resource-exhausted") return "今天的免費用量已用完，資料沒有遺失，稍後會恢復。";
  if (err?.code === "permission-denied") return "儲存被拒絕。請確認內容正確後再試一次。";
  return "儲存失敗。請檢查網路後重試，內容已保留。";
}

// ---------- 帳目寫入 ----------

/** 比對舊帳與新內容，以「人」記錄變動 */
export function diffEntry(before, after, people) {
  const changes = [];
  for (const field of ["paidBy", "totalCents", "item", "date"]) {
    if (before[field] !== after[field]) changes.push({ field, from: before[field], to: after[field] });
  }
  const personal = (e, uid) => {
    if (uid === null) return e.otherPersonalCents; // 對方尚未登入時，付款人一定是自己
    return e.paidBy === uid ? e.payerPersonalCents : e.otherPersonalCents;
  };
  for (const personUid of people) {
    const from = personal(before, personUid);
    const to = personal(after, personUid);
    if (from !== to) changes.push({ field: "personal", personUid, from, to });
  }
  if (linesText(before) !== linesText(after)) {
    changes.push({ field: "lines", from: before.lines || [], to: after.lines || [] });
  }
  if (before.kind === "expense" && owedCents(before) !== owedCents(after)) {
    changes.push({ field: "owedCents", from: owedCents(before), to: owedCents(after) });
  }
  return changes;
}

function linesText(e) {
  return JSON.stringify((e.lines || []).map((l) => [l.name, l.cents, l.owner]));
}

function sameContent(a, b) {
  return linesText(a) === linesText(b) && ["paidBy", "totalCents", "payerPersonalCents", "otherPersonalCents", "item", "date"].every((k) => a[k] === b[k]);
}

const entryRef = (id) => fb.doc(db, "entries", id);

function historyRecord(action, changes = []) {
  return { action, by: me(), at: fb.serverTimestamp(), changes };
}

async function createEntry(id, historyId, content) {
  await withTimeout(fb.runTransaction(db, async (tx) => {
    const ref = entryRef(id);
    const snap = await tx.get(ref);
    if (snap.exists()) return; // 上次其實已成功，重試不重複
    tx.set(ref, {
      ...content,
      createdBy: me(), createdAt: fb.serverTimestamp(),
      updatedBy: me(), updatedAt: fb.serverTimestamp(),
      deletedBy: null, deletedAt: null,
    });
    tx.set(fb.doc(ref, "history", historyId), historyRecord("create"));
  }));
}

/** 回傳 "ok"，或拋出 {code:"conflict", latest} / {code:"deleted"} */
async function updateEntry(id, historyId, content, baseUpdatedAt) {
  await withTimeout(fb.runTransaction(db, async (tx) => {
    const ref = entryRef(id);
    const snap = await tx.get(ref);
    const cur = snap.data();
    if (!snap.exists() || cur.deletedAt) throw { code: "deleted" };
    if (ms(cur.updatedAt) !== baseUpdatedAt) {
      if (cur.updatedBy === me() && sameContent(cur, content)) return; // 上次其實已成功
      throw { code: "conflict", latest: cur };
    }
    const people = [me(), otherUid()];
    tx.update(ref, { ...content, updatedBy: me(), updatedAt: fb.serverTimestamp() });
    tx.set(fb.doc(ref, "history", historyId), historyRecord("update", diffEntry(cur, { ...cur, ...content }, people)));
  }));
}

async function setDeleted(id, deleted) {
  const historyId = fb.doc(fb.collection(db, "entries", id, "history")).id;
  await withTimeout(fb.runTransaction(db, async (tx) => {
    const ref = entryRef(id);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw { code: "deleted" };
    if (Boolean(snap.data().deletedAt) === deleted) return;
    tx.update(ref, {
      deletedBy: deleted ? me() : null,
      deletedAt: deleted ? fb.serverTimestamp() : null,
      updatedBy: me(),
      updatedAt: fb.serverTimestamp(),
    });
    tx.set(fb.doc(ref, "history", historyId), historyRecord(deleted ? "delete" : "restore"));
  }));
}

async function deleteWithUndo(entry) {
  const ok = await confirmDialog({ title: "刪除這筆帳？", body: `${entry.item || "還款"} ${formatMoney(entry.totalCents)}。刪除後不再計入欠款，之後可在歷史紀錄復原。`, ok: "刪除", danger: true });
  if (!ok) return;
  try {
    await setDeleted(entry.id, true);
    location.hash = "#home";
    toast("已刪除", { label: "復原", run: () => restore(entry.id) });
  } catch (err) {
    toast(saveErrorText(err));
  }
}

async function restore(id) {
  try {
    await setDeleted(id, false);
    toast("已復原");
  } catch (err) {
    toast(saveErrorText(err));
  }
}

async function saveName(name) {
  await withTimeout(fb.runTransaction(db, async (tx) => {
    tx.set(fb.doc(db, "members", me()), { name });
  }));
}

// ---------- 列表 ----------

function entryEffect(e) {
  if (e.kind === "repayment") {
    const to = e.paidBy === me() ? otherName() : "你";
    return { text: `${nameOf(e.paidBy)}還${to} ${formatMoney(e.totalCents)}`, quiet: false };
  }
  const owed = owedCents(e);
  if (owed === 0) return { text: "不影響欠款", quiet: true };
  const debtor = e.paidBy === me() ? otherName() : "你";
  return { text: `這筆${debtor}應付 ${formatMoney(owed)}`, quiet: false };
}

function entryRow(e) {
  const effect = entryEffect(e);
  const edited = ms(e.updatedAt) !== ms(e.createdAt);
  const title = e.kind === "repayment" ? (e.item || "還款") : e.item;
  return h("li", {}, h("a", { class: "row", href: `#entry/${e.id}` },
    h("span", { class: "row-date" }, shortDate(e.date)),
    h("div", {},
      h("div", { class: "row-title" }, title, edited ? h("span", { class: "tag" }, "已修改") : null),
      e.kind === "expense" ? h("div", { class: "row-meta" }, `${nameOf(e.paidBy)}付 ${formatMoney(e.totalCents)}`) : null,
      h("div", { class: `row-effect${effect.quiet ? " quiet" : ""}` }, effect.text),
    ),
  ));
}

function loadingBlock() {
  return h("p", { class: "muted empty" }, "載入中…");
}

function renderHome() {
  const page = $("page-home");
  const add = h("a", { class: "btn primary wide large", href: "#add" }, "＋ 記一筆");
  if (!S.entriesLoaded) { page.replaceChildren(add, loadingBlock()); return; }
  const list = activeEntries();
  if (!list.length) {
    page.replaceChildren(add, h("div", { class: "empty" }, h("p", { class: "muted" }, "還沒有帳目。按「記一筆」新增第一筆。")));
    return;
  }
  page.replaceChildren(add, h("ul", { class: "ledger" }, list.slice(0, 10).map(entryRow)));
  if (list.length > 10) page.append(h("a", { class: "link-btn", href: "#history" }, "查看全部"));
}

function renderHistory() {
  const page = $("page-history");
  const head = h("div", { class: "page-head" }, h("h1", {}, "歷史紀錄"));
  if (!S.entriesLoaded) { page.replaceChildren(head, loadingBlock()); return; }
  const list = activeEntries();
  const groups = new Map();
  for (const e of list) {
    const key = e.date.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const deleted = S.entries.filter((e) => e.deletedAt).sort((a, b) => ms(b.deletedAt) - ms(a.deletedAt));
  const body = [head];
  if (!list.length) body.push(h("p", { class: "muted empty" }, "還沒有帳目。"));
  for (const [key, items] of groups) {
    const [y, m] = key.split("-");
    body.push(h("h2", { class: "month-head" }, `${y} 年 ${Number(m)} 月`), h("ul", { class: "ledger" }, items.map(entryRow)));
  }
  if (deleted.length) {
    const details = h("details", { class: "deleted", open: S.historyOpen, ontoggle: (ev) => { S.historyOpen = ev.target.open; } },
      h("summary", {}, `已刪除（${deleted.length}）`),
      h("ul", { class: "ledger" }, deleted.map((e) => h("li", {}, h("div", { class: "deleted-row" },
        h("div", {},
          h("div", { class: "row-title" }, `${e.item || "還款"} ${formatMoney(e.totalCents)}`),
          h("div", { class: "row-meta" }, `${nameOf(e.deletedBy)}於 ${timeText(e.deletedAt)} 刪除`),
        ),
        h("button", { class: "btn", type: "button", disabled: !navigator.onLine, onclick: () => restore(e.id) }, "復原"),
      )))),
    );
    body.push(details);
  }
  page.replaceChildren(...body);
}

// ---------- 記一筆／編輯 ----------

function segments(name, options, value, onchange, four = false) {
  return h("div", { class: `segments${four ? " four" : ""}` }, options.map((o) => h("label", {},
    h("input", { type: "radio", name, value: o.value, checked: o.value === value, disabled: o.disabled, onchange }),
    h("span", {}, o.label),
  )));
}

function field(label, control, hint) {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control, hint ? h("span", { class: "muted small" }, hint) : null);
}

function moneyInput(id, value) {
  return h("input", { id, type: "text", class: "money-input", inputmode: "decimal", autocomplete: "off", placeholder: "0.00", value });
}

function renderExpenseForm(entry) {
  const page = $("page-form");
  const other = otherUid();
  const entryId = entry?.id ?? fb.doc(fb.collection(db, "entries")).id;
  const newHistoryId = () => fb.doc(fb.collection(db, "entries", entryId, "history")).id;
  let historyId = newHistoryId();
  let baseUpdatedAt = entry ? ms(entry.updatedAt) : 0;

  const initialPaidBy = entry?.paidBy ?? me();
  // 表單內依「人」保存個人用品，儲存前才換算
  const myInit = entry ? (entry.paidBy === me() ? entry.payerPersonalCents : entry.otherPersonalCents) : 0;
  const otherInit = entry ? (entry.paidBy === me() ? entry.otherPersonalCents : entry.payerPersonalCents) : 0;
  let mode = "shared";
  if (entry) {
    if (myInit === 0 && otherInit === 0) mode = "shared";
    else if (myInit === entry.totalCents) mode = "mine";
    else if (otherInit === entry.totalCents) mode = "theirs";
    else mode = "mixed";
  }

  const total = moneyInput("f-total", entry ? centsPlain(entry.totalCents) : "");
  const item = h("input", { id: "f-item", type: "text", maxLength: 100, autocomplete: "off", list: "item-suggestions", value: entry?.item ?? "" });
  const date = h("input", { id: "f-date", type: "date", max: localDate(), value: entry?.date ?? localDate() });
  const suggestions = h("datalist", { id: "item-suggestions" },
    [...new Set(activeEntries().filter((e) => e.kind === "expense").map((e) => e.item))].slice(0, 50).map((v) => h("option", { value: v })));

  const lineNames = h("datalist", { id: "line-suggestions" },
    [...new Set(activeEntries().flatMap((e) => (e.lines || []).map((l) => l.name)))].slice(0, 50).map((v) => h("option", { value: v })));
  const linesBox = h("div", { class: "lines" });

  function addLine(line = {}, focus = true) {
    const ownerValue = line.owner === undefined || line.owner === "shared" ? "shared" : line.owner === me() ? "me" : "other";
    const name = h("input", { type: "text", class: "line-name", maxLength: 50, autocomplete: "off", list: "line-suggestions", placeholder: "細項名稱", "aria-label": "細項名稱", value: line.name ?? "" });
    const cents = moneyInput(null, line.cents ? centsPlain(line.cents) : "");
    cents.classList.add("line-cents");
    cents.setAttribute("aria-label", "細項金額");
    const owner = h("select", { class: "line-owner", "aria-label": "細項屬於誰" },
      h("option", { value: "shared" }, "共同"),
      h("option", { value: "me" }, "你"),
      h("option", { value: "other" }, otherName()),
    );
    owner.value = ownerValue;
    const row = h("div", { class: "line" }, name, cents, owner,
      h("button", { class: "line-remove", type: "button", "aria-label": "移除這個細項", onclick: () => { row.remove(); onInput(); } }, "×"));
    linesBox.append(row);
    if (focus) name.focus();
  }

  const addLineBtn = h("button", { class: "btn wide", type: "button", onclick: () => { addLine(); onInput(); } }, "＋ 加細項");
  const linesSection = h("div", { class: "lines-section" }, linesBox, addLineBtn);
  const preview = h("div", { class: "preview", "aria-live": "polite" });
  const errorEl = h("p", { class: "error form-error", role: "alert", hidden: true });
  const saveBtn = h("button", { class: "btn primary wide large", type: "submit", "data-save": "" }, "儲存");

  const paidByValue = () => page.querySelector('input[name="paidBy"]:checked').value;
  const modeValue = () => page.querySelector('input[name="mode"]:checked').value;

  function read() {
    const totalCents = parseMoney(total.value);
    const m = modeValue();
    const lines = [];
    let lineProblem = "";
    let mine = 0;
    let theirs = 0;
    for (const row of linesBox.querySelectorAll(".line")) {
      const name = row.querySelector(".line-name").value.trim();
      const rawCents = row.querySelector(".line-cents").value.trim();
      if (!name && !rawCents) continue;
      const cents = parseMoney(rawCents);
      if (!cents) { lineProblem = `請輸入細項「${name || "未命名"}」的正確金額。`; continue; }
      if (!name) { lineProblem = "請輸入細項名稱。"; continue; }
      const picked = m === "mixed" ? row.querySelector(".line-owner").value : { shared: "shared", mine: "me", theirs: "other" }[m];
      const owner = picked === "shared" ? "shared" : picked === "me" ? me() : other;
      lines.push({ name, cents, owner });
      if (picked === "me") mine += cents;
      if (picked === "other") theirs += cents;
    }
    const linesSum = lines.reduce((a, l) => a + l.cents, 0);
    if (m === "mine") mine = totalCents ?? 0;
    if (m === "theirs") theirs = totalCents ?? 0;
    return { totalCents, mine, theirs, lines, linesSum, lineProblem };
  }

  function refresh() {
    const isMixed = modeValue() === "mixed";
    linesBox.classList.toggle("mixed", isMixed);
    const { totalCents, mine, theirs, lines, linesSum, lineProblem } = read();
    let problem = "";
    if (total.value.trim() && (totalCents === null || totalCents === 0)) problem = "請輸入正確的總金額，最多兩位小數。";
    else if (lineProblem) problem = lineProblem;
    else if (totalCents !== null && linesSum > totalCents) problem = `細項合計 ${formatMoney(linesSum)} 超過總金額。`;

    preview.hidden = false;
    if (problem) {
      preview.replaceChildren(h("span", { class: "error" }, problem));
    } else if (!totalCents) {
      preview.replaceChildren(h("span", { class: "muted" }, "輸入金額後，這裡會顯示這筆怎麼分。"));
    } else {
      const paidBy = paidByValue();
      const e = {
        totalCents,
        payerPersonalCents: paidBy === me() ? mine : theirs,
        otherPersonalCents: paidBy === me() ? theirs : mine,
      };
      const owed = owedCents(e);
      const shared = sharedCents(e);
      const debtor = paidBy === me() ? otherName() : "你";
      const payer = nameOf(paidBy);
      const rest = totalCents - linesSum;
      const restOwner = { shared: "共同", mixed: "共同", mine: "你", theirs: otherName() }[modeValue()];
      preview.replaceChildren(
        h("strong", {}, owed ? `這筆${debtor}應付${payer} ${formatMoney(owed)}` : "不影響欠款"),
        h("span", { class: "muted small preview-line" }, `共同用品 ${formatMoney(shared)}（各付一半）`),
      );
      if (lines.length && rest > 0) preview.append(h("span", { class: "muted small preview-line" }, `其他 ${formatMoney(rest)}（${restOwner}）`));
      if (shared % 2) preview.append(h("span", { class: "muted small preview-line" }, "多出的 1 分由付款人吸收"));
    }
    saveBtn.dataset.invalid = problem ? "1" : "";
    syncSaveButtons();
  }

  const onInput = () => { S.formDirty = true; refresh(); };

  async function submit(ev) {
    ev.preventDefault();
    errorEl.hidden = true;
    const { totalCents, mine, theirs, lines } = read();
    const itemText = item.value.trim();
    let message = "";
    if (!totalCents) message = "請輸入總金額。";
    else if (!itemText) message = "請輸入項目。";
    else if (!date.value || date.value > localDate()) message = "請選擇今天或以前的日期。";
    if (message) { errorEl.textContent = message; errorEl.hidden = false; return; }

    const paidBy = paidByValue();
    const content = {
      kind: "expense",
      paidBy,
      totalCents,
      payerPersonalCents: paidBy === me() ? mine : theirs,
      otherPersonalCents: paidBy === me() ? theirs : mine,
      item: itemText,
      date: date.value,
      lines,
    };
    if (entry && (!S.formDirty || sameContent(entry, content))) {
      S.formDirty = false;
      location.replace(`#entry/${entry.id}`);
      return;
    }
    await persist(content);
  }

  async function persist(content) {
    saveBtn.disabled = true;
    saveBtn.textContent = "儲存中…";
    try {
      if (entry) await updateEntry(entryId, historyId, content, baseUpdatedAt);
      else await createEntry(entryId, historyId, content);
      S.formDirty = false;
      location.replace(entry ? `#entry/${entryId}` : "#home");
      toast("已儲存");
    } catch (err) {
      saveBtn.textContent = "儲存";
      syncSaveButtons();
      if (err?.code === "conflict") {
        const l = err.latest;
        const go = await confirmDialog({
          title: "對方剛修改過這筆",
          body: `最新內容是 ${l.date} ${l.item} ${formatMoney(l.totalCents)}，由${nameOf(l.paidBy)}付款。要用你的內容覆蓋嗎？`,
          ok: "覆蓋",
        });
        if (go) {
          baseUpdatedAt = ms(l.updatedAt);
          historyId = newHistoryId();
          await persist(content);
        }
      } else if (err?.code === "deleted") {
        S.formDirty = false;
        toast("對方已刪除這筆，修改沒有儲存。");
        location.replace(`#entry/${entryId}`);
      } else {
        errorEl.textContent = saveErrorText(err);
        errorEl.hidden = false;
      }
    }
  }

  const form = h("form", { class: "card", novalidate: true, onsubmit: submit, oninput: onInput, onchange: onInput },
    h("fieldset", { class: "choice" }, h("legend", {}, "付款人"),
      segments("paidBy", [
        { value: me(), label: "你" },
        { value: other ?? "__none", label: otherName(), disabled: !other },
      ], initialPaidBy, onInput),
      !other ? h("p", { class: "muted small" }, "對方第一次登入後才能選擇。") : null,
    ),
    field("總金額", total),
    field("項目", item),
    field("日期", date),
    h("fieldset", { class: "choice" }, h("legend", {}, "這筆是？"),
      segments("mode", [
        { value: "shared", label: "全部共同" },
        { value: "mine", label: "全是你的" },
        { value: "theirs", label: `全是${otherName()}的` },
        { value: "mixed", label: "混合" },
      ], mode, onInput, true),
    ),
    linesSection,
    suggestions,
    lineNames,
    preview,
    errorEl,
    h("div", { class: "form-actions" }, saveBtn),
  );

  page.replaceChildren(
    h("div", { class: "page-head" }, h("h1", {}, entry ? "修改帳目" : "記一筆"), h("a", { class: "btn", href: entry ? `#entry/${entry.id}` : "#home" }, "取消")),
    form,
  );
  // 帶入細項。舊帳沒有細項但有個人金額時，轉成細項列
  const initialLines = entry?.lines?.length ? entry.lines : [];
  initialLines.forEach((l) => addLine({ ...l, owner: l.owner === null ? other : l.owner }, false));
  if (entry && !initialLines.length && mode === "mixed") {
    if (myInit) addLine({ name: "個人用品", cents: myInit, owner: me() }, false);
    if (otherInit) addLine({ name: "個人用品", cents: otherInit, owner: other ?? "__other" }, false);
  }
  // 選「混合」時，如果還沒有細項，自動開一列
  page.querySelectorAll('input[name="mode"]').forEach((el) => el.addEventListener("change", () => {
    if (modeValue() === "mixed" && !linesBox.querySelector(".line")) { addLine(); refresh(); }
  }));
  refresh();
  if (!entry) total.focus();
}

// ---------- 明細 ----------

const FIELD_LABEL = { paidBy: "付款人", totalCents: "總金額", item: "項目", date: "日期", owedCents: "這筆應付" };

function changeText(c, kind) {
  if (c.field === "personal") return `${nameOf(c.personUid)}的個人用品 ${formatMoney(c.from)} → ${formatMoney(c.to)}`;
  if (c.field === "paidBy") return `${kind === "repayment" ? "還款人" : "付款人"} ${nameOf(c.from)} → ${nameOf(c.to)}`;
  if (c.field === "totalCents" || c.field === "owedCents") {
    const label = c.field === "totalCents" && kind === "repayment" ? "金額" : FIELD_LABEL[c.field];
    return `${label} ${formatMoney(c.from)} → ${formatMoney(c.to)}`;
  }
  if (c.field === "lines") return `細項 ${linesSummary(c.from)} → ${linesSummary(c.to)}`;
  if (c.field === "item") return `${kind === "repayment" ? "備註" : "項目"} ${c.from || "（空白）"} → ${c.to || "（空白）"}`;
  if (c.field === "date") return `日期 ${slashDate(c.from)} → ${slashDate(c.to)}`;
  return "";
}

function ownerLabel(owner) {
  return owner === "shared" ? "共同" : nameOf(owner);
}

function linesSummary(lines) {
  if (!lines?.length) return "（沒有）";
  return lines.map((l) => `${l.name} ${formatMoney(l.cents)}（${ownerLabel(l.owner)}）`).join("、");
}

const ACTION_LABEL = { create: "新增", update: "修改", delete: "刪除", restore: "復原" };

async function loadHistory(entry, container) {
  try {
    const snap = await fb.getDocs(fb.collection(db, "entries", entry.id, "history"));
    const rows = snap.docs.map((d) => d.data({ serverTimestamps: "estimate" })).sort((a, b) => ms(b.at) - ms(a.at));
    container.replaceChildren(h("ul", { class: "timeline" }, rows.map((r) => h("li", {},
      h("time", {}, timeText(r.at)),
      h("div", {},
        `${nameOf(r.by)}${ACTION_LABEL[r.action] ?? r.action}`,
        (r.changes || []).map((c) => h("span", { class: "change" }, changeText(c, entry.kind))),
      ),
    ))));
  } catch {
    container.replaceChildren(h("p", { class: "muted" }, "無法載入修改紀錄，請檢查網路。"));
  }
}

function renderEntry() {
  const page = $("page-entry");
  const e = findEntry(S.routeId);
  const back = h("a", { class: "btn", href: "#history" }, "全部帳目");
  if (!S.entriesLoaded) { page.replaceChildren(loadingBlock()); return; }
  if (!e) {
    page.replaceChildren(h("div", { class: "page-head" }, h("h1", {}, "找不到這筆帳"), back));
    return;
  }
  // 內容沒變時不重建，避免重複讀取修改紀錄
  const key = `${e.id}|${ms(e.updatedAt)}|${Object.values(S.members).map((m) => m.name).join()}`;
  if (S.entryKey === key) return;
  S.entryKey = key;
  const isRepay = e.kind === "repayment";
  const rows = [["日期", slashDate(e.date)]];
  if (isRepay) {
    rows.push(["還款人", nameOf(e.paidBy)], ["金額", formatMoney(e.totalCents)]);
    if (e.item) rows.push(["備註", e.item]);
  } else {
    const myP = e.paidBy === me() ? e.payerPersonalCents : e.otherPersonalCents;
    const otherP = e.paidBy === me() ? e.otherPersonalCents : e.payerPersonalCents;
    rows.push(["付款人", nameOf(e.paidBy)], ["總金額", formatMoney(e.totalCents)]);
    if (myP && !e.lines?.length) rows.push(["你的個人用品", formatMoney(myP)]);
    if (otherP && !e.lines?.length) rows.push([`${otherName()}的個人用品`, formatMoney(otherP)]);
    for (const l of e.lines || []) rows.push([l.name, `${formatMoney(l.cents)}（${ownerLabel(l.owner)}）`]);
    if (e.lines?.length) {
      const rest = e.totalCents - e.lines.reduce((a, l) => a + l.cents, 0);
      if (rest > 0) rows.push(["其他", formatMoney(rest)]);
    }
    rows.push(["共同用品", formatMoney(sharedCents(e))], ["結果", entryEffect(e).text], ["你的花費", formatMoney(myCost(e, me()))]);
  }
  if (e.deletedAt) rows.push(["狀態", `${nameOf(e.deletedBy)}於 ${timeText(e.deletedAt)} 刪除`]);

  const actions = e.deletedAt
    ? h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", "data-save": "", onclick: () => restore(e.id) }, "復原"))
    : h("div", { class: "actions" },
      h("a", { class: "btn primary", href: isRepay ? `#repay/${e.id}` : `#edit/${e.id}` }, "修改"),
      h("button", { class: "btn danger", type: "button", onclick: () => deleteWithUndo(e) }, "刪除"),
    );
  const historyBox = h("div", {}, h("p", { class: "muted small" }, "載入中…"));
  page.replaceChildren(
    h("div", { class: "page-head" }, h("h1", {}, isRepay ? (e.item || "還款") : e.item), back),
    h("div", { class: "stack" },
      h("div", { class: "card" }, h("dl", { class: "detail" }, rows.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v))))),
      actions,
      h("div", { class: "card" }, h("h2", {}, "修改紀錄"), historyBox),
    ),
  );
  syncSaveButtons();
  loadHistory(e, historyBox);
}

// ---------- 還款 ----------

function balanceTicket(net) {
  if (tooManyMembers()) {
    return h("div", { class: "card error" }, "帳本出現超過兩位成員，無法計算欠款。請檢查 Firebase Console 的 members。");
  }
  if (net === 0) {
    return h("div", { class: "ticket settled" }, h("div", { class: "ticket-label" }, "目前不用還款"), h("div", { class: "muted" }, "已結清"));
  }
  return h("div", { class: "ticket" },
    h("div", { class: "ticket-label" }, net > 0 ? `${otherName()}欠你` : `你欠${otherName()}`),
    h("div", { class: "ticket-amount" }, formatMoney(Math.abs(net))),
  );
}

function renderRepay() {
  const page = $("page-repay");
  const editing = S.routeId ? findEntry(S.routeId) : null;
  const head = h("div", { class: "page-head" }, h("h1", {}, editing ? "修改還款" : "還款"),
    editing ? h("a", { class: "btn", href: `#entry/${editing.id}` }, "取消") : null);
  if (!S.entriesLoaded) { page.replaceChildren(head, loadingBlock()); return; }
  if (S.routeId && (!editing || editing.kind !== "repayment")) {
    page.replaceChildren(h("div", { class: "page-head" }, h("h1", {}, "找不到這筆還款")));
    return;
  }
  const net = computeNet(S.entries, me());
  const body = [head, balanceTicket(net)];
  const other = otherUid();

  if (tooManyMembers() || (net === 0 && !editing)) {
    page.replaceChildren(...body);
    return;
  }
  if (!other) {
    body.push(h("p", { class: "muted" }, "對方第一次登入後才能記錄還款。"));
    page.replaceChildren(...body);
    return;
  }
  if (S.stale && !editing) {
    body.push(h("p", { class: "muted" }, "資料可能不是最新，連線恢復後才能記錄還款。"));
    page.replaceChildren(...body);
    return;
  }

  const entryId = editing?.id ?? fb.doc(fb.collection(db, "entries")).id;
  const newHistoryId = () => fb.doc(fb.collection(db, "entries", entryId, "history")).id;
  let historyId = newHistoryId();
  let baseUpdatedAt = editing ? ms(editing.updatedAt) : 0;
  const defaultPayer = editing?.paidBy ?? (net > 0 ? other : me());
  const amount = moneyInput("r-amount", centsPlain(editing?.totalCents ?? Math.abs(net)));
  const date = h("input", { id: "r-date", type: "date", max: localDate(), value: editing?.date ?? localDate() });
  const note = h("input", { id: "r-note", type: "text", maxLength: 100, autocomplete: "off", value: editing?.item ?? "" });
  const errorEl = h("p", { class: "error form-error", role: "alert", hidden: true });
  const saveBtn = h("button", { class: "btn primary wide large", type: "submit", "data-save": "" }, "記錄還款");

  async function persist(content) {
    saveBtn.disabled = true;
    saveBtn.textContent = "儲存中…";
    try {
      if (editing) await updateEntry(entryId, historyId, content, baseUpdatedAt);
      else await createEntry(entryId, historyId, content);
      S.formDirty = false;
      location.replace(editing ? `#entry/${entryId}` : "#home");
      toast("已記錄還款");
    } catch (err) {
      saveBtn.textContent = "記錄還款";
      syncSaveButtons();
      if (err?.code === "conflict") {
        const go = await confirmDialog({
          title: "對方剛修改過這筆",
          body: `最新金額是 ${formatMoney(err.latest.totalCents)}。要用你的內容覆蓋嗎？`,
          ok: "覆蓋",
        });
        if (go) {
          baseUpdatedAt = ms(err.latest.updatedAt);
          historyId = newHistoryId();
          await persist(content);
        }
      } else if (err?.code === "deleted") {
        S.formDirty = false;
        toast("對方已刪除這筆，修改沒有儲存。");
        location.replace(`#entry/${entryId}`);
      } else {
        errorEl.textContent = saveErrorText(err);
        errorEl.hidden = false;
      }
    }
  }

  async function submit(ev) {
    ev.preventDefault();
    errorEl.hidden = true;
    const cents = parseMoney(amount.value);
    const paidBy = page.querySelector('input[name="repayBy"]:checked').value;
    let message = "";
    if (!cents) message = "請輸入正確的金額，最多兩位小數。";
    else if (!date.value || date.value > localDate()) message = "請選擇今天或以前的日期。";
    if (message) { errorEl.textContent = message; errorEl.hidden = false; return; }

    const base = computeNet(S.entries.filter((e) => e.id !== editing?.id), me());
    const after = base + (paidBy === me() ? cents : -cents);
    const worse = after !== 0 && (Math.sign(after) !== Math.sign(base) || Math.abs(after) > Math.abs(base));
    if (worse) {
      const text = after > 0 ? `${otherName()}欠你 ${formatMoney(after)}` : `你欠${otherName()} ${formatMoney(-after)}`;
      const go = await confirmDialog({ title: "金額超過目前欠款", body: `這樣會變成${text}。確定要儲存嗎？`, ok: "儲存" });
      if (!go) return;
    }
    const content = {
      kind: "repayment", paidBy, totalCents: cents,
      payerPersonalCents: 0, otherPersonalCents: 0,
      item: note.value.trim(), date: date.value,
    };
    if (editing && sameContent(editing, content)) {
      S.formDirty = false;
      location.replace(`#entry/${editing.id}`);
      return;
    }
    await persist(content);
  }

  const form = h("form", { class: "card", novalidate: true, onsubmit: submit, oninput: () => { S.formDirty = true; } },
    h("fieldset", { class: "choice" }, h("legend", {}, "還款人"),
      segments("repayBy", [{ value: me(), label: "你" }, { value: other, label: otherName() }], defaultPayer, () => { S.formDirty = true; })),
    field("金額", amount),
    field("日期", date),
    field("備註（選填）", note),
    errorEl,
    h("div", { class: "form-actions" }, saveBtn),
  );
  form.style.marginTop = "20px";
  body.push(form);
  page.replaceChildren(...body);
  syncSaveButtons();
}

// ---------- 我的花費 ----------

function applySpendPreset(preset) {
  const f = S.spend;
  f.preset = preset;
  f.error = "";
  if (preset === "month" || preset === "last") {
    const r = monthRange(preset === "month" ? 0 : -1);
    f.from = r.from;
    f.to = r.to;
  } else if (preset === "all") {
    f.from = "";
    f.to = "";
  }
  f.draftFrom = f.from;
  f.draftTo = f.to;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h("textarea", { value: text });
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

function renderSpend() {
  const page = $("page-spend");
  const f = S.spend;
  if (!f.from && !f.to && f.preset === "month") applySpendPreset("month");
  const head = h("div", { class: "page-head" }, h("h1", {}, "我的花費"));
  if (!S.entriesLoaded) { page.replaceChildren(head, loadingBlock()); return; }

  const rows = spendRows(S.entries, me(), f.from, f.to);
  const totalCents = rows.reduce((sum, r) => sum + r.cents, 0);
  let range;
  if (f.preset === "all") {
    range = rows.length ? `${slashDate(rows[0].date)} – ${slashDate(rows[rows.length - 1].date)}` : "全部日期";
  } else {
    range = `${slashDate(f.from)} – ${slashDate(f.to)}`;
  }

  const onDate = (key) => (ev) => {
    f[key] = ev.target.value;
    if (f.draftFrom && f.draftTo && f.draftFrom > f.draftTo) {
      f.error = "開始日期不能晚於結束日期。";
    } else if (!f.draftFrom || !f.draftTo) {
      f.error = "請選擇開始和結束日期。";
    } else {
      f.error = "";
      f.preset = "custom";
      f.from = f.draftFrom;
      f.to = f.draftTo;
    }
    renderSpend();
  };

  const presetBtn = (key, label) => h("button", {
    class: "btn", type: "button", "aria-pressed": String(f.preset === key),
    onclick: () => { applySpendPreset(key); renderSpend(); },
  }, label);

  const copyBtn = h("button", {
    class: "btn primary wide", type: "button", disabled: !rows.length,
    onclick: async () => {
      const ok = await copyText(toTsv(rows));
      toast(ok ? `已複製 ${rows.length} 筆` : "無法自動複製，請手動選取表格後複製。");
    },
  }, "複製表格");

  const table = rows.length
    ? h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "日期"), h("th", {}, "項目"), h("th", {}, "細項"), h("th", { class: "num" }, "金額"))),
      h("tbody", {}, rows.map((r) => h("tr", {},
        h("td", { class: "date" }, r.date), h("td", { class: "item" }, r.item), h("td", { class: "item" }, r.detail), h("td", { class: "num" }, centsPlain(r.cents)),
      ))),
    ))
    : h("div", { class: "table-wrap" }, h("p", { class: "muted empty" }, "這段期間沒有花費"));

  page.replaceChildren(
    head,
    h("div", { class: "spend-layout stack" },
      h("div", { class: "stack" },
        h("div", { class: "spend-head" },
          h("div", { class: "spend-range" }, range),
          h("div", { class: "spend-total" }, `總金額 ${formatMoney(totalCents)}`),
        ),
        h("div", { class: "presets" }, presetBtn("month", "本月"), presetBtn("last", "上月"), presetBtn("all", "全部")),
        h("div", { class: "date-range" },
          field("開始日期", h("input", { type: "date", id: "s-from", value: f.draftFrom, onchange: onDate("draftFrom") })),
          field("結束日期", h("input", { type: "date", id: "s-to", value: f.draftTo, onchange: onDate("draftTo") })),
        ),
        f.error ? h("p", { class: "error", role: "alert" }, f.error) : null,
        copyBtn,
      ),
      table,
    ),
  );
}

// ---------- 設定 ----------

function exportCsv() {
  const header = ["日期", "類型", "項目", "付款人", "細項", "總金額", "付款人個人", "對方個人", "共同金額", "對方應付", "狀態", "建立者", "建立時間", "最後修改者", "最後修改時間"];
  const nick = (uid) => (uid ? memberName(uid) : "");
  const iso = (ts) => (ts?.toDate ? `${localDate(ts.toDate())} ${ts.toDate().toTimeString().slice(0, 8)}` : "");
  const lines = [...S.entries].sort((a, b) => a.date.localeCompare(b.date) || ms(a.createdAt) - ms(b.createdAt)).map((e) => {
    const expense = e.kind === "expense";
    return [
      e.date, expense ? "消費" : "還款", e.item, nick(e.paidBy), (e.lines || []).map((l) => `${l.name} ${centsPlain(l.cents)}（${l.owner === "shared" ? "共同" : nick(l.owner) || "對方"}）`).join("；"), centsPlain(e.totalCents),
      expense ? centsPlain(e.payerPersonalCents) : "", expense ? centsPlain(e.otherPersonalCents) : "",
      expense ? centsPlain(sharedCents(e)) : "", expense ? centsPlain(owedCents(e)) : "",
      e.deletedAt ? "已刪除" : "有效", nick(e.createdBy), iso(e.createdAt), nick(e.updatedBy), iso(e.updatedAt),
    ].map(csvCell).join(",");
  });
  const blob = new Blob(["﻿", [header.join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: `shared-ledger-${localDate()}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast(`已匯出 ${lines.length} 筆`);
}

function renderSettings() {
  const page = $("page-settings");
  const input = h("input", { id: "set-name", type: "text", maxLength: 20, autocomplete: "off", value: S.members[me()]?.name ?? "" });
  const saveBtn = h("button", { class: "btn primary", type: "submit", "data-save": "" }, "儲存暱稱");
  const errorEl = h("p", { class: "error form-error", role: "alert", hidden: true });
  page.replaceChildren(
    h("div", { class: "page-head" }, h("h1", {}, "設定")),
    h("div", { class: "stack" },
      h("form", {
        class: "card", novalidate: true,
        onsubmit: async (ev) => {
          ev.preventDefault();
          const name = input.value.trim();
          errorEl.hidden = true;
          if (!name) { errorEl.textContent = "請輸入暱稱。"; errorEl.hidden = false; return; }
          saveBtn.disabled = true;
          try {
            await saveName(name);
            toast("已儲存暱稱");
          } catch (err) {
            errorEl.textContent = saveErrorText(err);
            errorEl.hidden = false;
          }
          syncSaveButtons();
        },
      }, field("你的暱稱", input, "對方會看到這個名稱。"), errorEl, h("div", { class: "form-actions" }, saveBtn)),
      h("div", { class: "card stack" },
        h("h2", {}, "備份"),
        h("p", { class: "muted small" }, `目前共 ${S.entries.length} 筆帳目（包含已刪除）。`),
        h("button", { class: "btn wide", type: "button", disabled: !S.entriesLoaded || !S.entries.length, onclick: exportCsv }, "匯出全部帳目（CSV）"),
      ),
      h("p", { class: "muted small" }, `目前登入：${S.user?.email ?? ""}`),
    ),
  );
  syncSaveButtons();
}

// ---------- 入口畫面 ----------

function renderGate() {
  const page = $("page-gate");
  const title = h("h1", {}, "共同帳本");
  const retry = h("button", { class: "btn primary", type: "button", onclick: startListeners }, "重試");
  const loginBtn = h("button", { class: "btn primary wide large", type: "button", onclick: login }, "使用 Google 帳戶登入");
  let content;
  switch (S.gate) {
    case "unconfigured":
      content = [title, h("p", {}, "還沒有填入 Firebase 設定。請在 script.js 最上方填入 firebaseConfig。")];
      break;
    case "sdkError":
      content = [title, h("p", {}, "無法載入必要的程式。請檢查網路後重新整理頁面。")];
      break;
    case "login":
      content = [title, h("p", { class: "muted" }, "兩人一起記帳，隨時知道誰該還誰多少。"), loginBtn, S.loginError ? h("p", { class: "error", role: "alert" }, S.loginError) : null];
      break;
    case "denied":
      content = [title, h("p", { class: "error", role: "alert" }, `此帳戶（${S.deniedEmail}）沒有使用權限。`), h("p", { class: "muted small" }, "請改用另一個 Google 帳戶。"), loginBtn];
      break;
    case "neterror":
      content = [title, h("p", {}, "暫時無法連線。請檢查網路後重試。"), retry];
      break;
    case "setup": {
      const input = h("input", { id: "setup-name", type: "text", maxLength: 20, autocomplete: "off" });
      const errorEl = h("p", { class: "error form-error", role: "alert", hidden: true });
      const btn = h("button", { class: "btn primary wide large", type: "submit", "data-save": "" }, "開始使用");
      content = [title, h("form", {
        class: "card", novalidate: true,
        onsubmit: async (ev) => {
          ev.preventDefault();
          const name = input.value.trim();
          errorEl.hidden = true;
          if (!name) { errorEl.textContent = "請輸入暱稱。"; errorEl.hidden = false; return; }
          btn.disabled = true;
          try {
            await saveName(name);
          } catch (err) {
            errorEl.textContent = saveErrorText(err);
            errorEl.hidden = false;
            syncSaveButtons();
          }
        },
      }, field("你的暱稱", input, "對方會看到這個名稱，例如「哥哥」。"), errorEl, h("div", { class: "form-actions" }, btn))];
      break;
    }
    default:
      content = [title, h("p", { class: "muted" }, "載入中…")];
  }
  // 暱稱輸入中收到快照時，不要清掉內容
  if (S.gate === "setup" && page.dataset.gate === "setup") return;
  page.dataset.gate = S.gate;
  page.replaceChildren(h("div", { class: "gate" }, content));
}

// ---------- 路由與渲染 ----------

function syncSaveButtons() {
  for (const btn of document.querySelectorAll("[data-save]")) {
    btn.disabled = !navigator.onLine || btn.dataset.invalid === "1";
  }
}

function updateBanner() {
  const el = $("banner");
  let text = "";
  if (S.quota) text = "今天的免費用量已用完，資料沒有遺失，稍後會恢復。";
  else if (!navigator.onLine) text = "目前沒有網路，暫時不能儲存。";
  else if (S.stale) text = "資料可能不是最新。";
  el.textContent = text;
  el.hidden = !text;
}

const PAGE_OF = { home: "home", add: "form", edit: "form", entry: "entry", repay: "repay", history: "history", spend: "spend", settings: "settings" };
const NAV_OF = { home: "home", add: "home", edit: "history", entry: "history", repay: "repay", history: "history", spend: "spend", settings: "settings" };

function parseRoute() {
  const [name, id] = (location.hash || "#home").slice(1).split("/");
  S.route = PAGE_OF[name] ? name : "home";
  S.routeId = id ? decodeURIComponent(id) : null;
}

function showPage(name) {
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${name}`));
}

function render() {
  updateBanner();
  document.body.classList.toggle("gated", S.gate !== "app");
  if (S.gate !== "app") {
    showPage("gate");
    renderGate();
    return;
  }
  $("page-gate").dataset.gate = "";
  $("page-gate").replaceChildren();
  parseRoute();
  showPage(PAGE_OF[S.route]);
  document.body.classList.toggle("page-narrow", ["add", "edit", "repay", "settings"].includes(S.route));
  document.body.classList.toggle("page-wide", S.route === "spend");
  document.querySelectorAll("#nav a").forEach((a) => {
    const current = a.dataset.nav === NAV_OF[S.route];
    a.classList.toggle("current", current);
    if (current) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });

  const r = S.route;
  if (r === "home") renderHome();
  else if (r === "history") renderHistory();
  else if (r === "spend") renderSpend();
  else if (r === "settings") { if (!S.formDirty && !isTyping("set-name")) renderSettings(); }
  else if (r === "entry") renderEntry();
  else if (r === "repay") {
    // 使用者輸入中只更新上方的欠款，不重建表單
    if (S.formDirty) {
      const ticket = document.querySelector("#page-repay .ticket, #page-repay .card.error");
      if (ticket) ticket.replaceWith(balanceTicket(computeNet(S.entries, me())));
    } else renderRepay();
  } else if (r === "add" || r === "edit") {
    const key = `${location.hash}|${memberIds().join()}`;
    if (r === "add" && S.formKey !== key && !S.formDirty) {
      S.formKey = key;
      renderExpenseForm(null);
    } else if (r === "edit") {
      if (!S.entriesLoaded) {
        $("page-form").replaceChildren(loadingBlock());
      } else if (S.formKey !== key && !S.formDirty) {
        const e = findEntry(S.routeId);
        S.formKey = key;
        if (e && e.kind === "expense" && !e.deletedAt) renderExpenseForm(e);
        else $("page-form").replaceChildren(h("h1", {}, "這筆帳不能修改"), h("a", { class: "btn", href: "#history" }, "回到歷史紀錄"));
      }
    }
  }
  syncSaveButtons();
}

const isTyping = (id) => document.activeElement?.id === id;

let currentHash = location.hash || "#home";
let ignoreHash = false;

function onHashChange() {
  if (ignoreHash) { ignoreHash = false; return; }
  const next = location.hash || "#home";
  if (S.formDirty && next !== currentHash) {
    ignoreHash = true;
    location.hash = currentHash;
    confirmDialog({ title: "離開這一頁？", body: "尚未儲存的內容會遺失。", ok: "離開", cancel: "繼續編輯" }).then((leave) => {
      if (leave) {
        S.formDirty = false;
        location.hash = next;
      }
    });
    return;
  }
  currentHash = next;
  S.formDirty = false;
  S.formKey = null;
  S.entryKey = null;
  window.scrollTo(0, 0);
  render();
}

// ---------- 啟動 ----------

async function start() {
  window.addEventListener("hashchange", onHashChange);
  window.addEventListener("online", render);
  window.addEventListener("offline", render);
  window.addEventListener("beforeunload", (ev) => {
    if (S.formDirty) ev.preventDefault();
  });

  if (firebaseConfig.apiKey === "在此填入") {
    S.gate = "unconfigured";
    render();
    return;
  }

  try {
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
    const [appMod, authMod, storeMod] = await Promise.all([
      import(`${base}/firebase-app.js`),
      import(`${base}/firebase-auth.js`),
      import(`${base}/firebase-firestore.js`),
    ]);
    fb = { ...appMod, ...authMod, ...storeMod };
  } catch {
    S.gate = "sdkError";
    render();
    return;
  }

  const app = fb.initializeApp(firebaseConfig);
  auth = fb.getAuth(app);
  db = fb.getFirestore(app);

  fb.onAuthStateChanged(auth, (user) => {
    if (user) {
      clearSession();
      S.user = user;
      S.loginError = "";
      startListeners();
    } else {
      stopListeners();
      clearSession();
      // 沒有權限時留在說明畫面，讓使用者看到原因
      if (S.gate !== "denied") S.gate = "login";
      render();
    }
  });
}

// 測試時可用 ?noauto 只載入純函式
if (!new URLSearchParams(location.search).has("noauto")) start();
